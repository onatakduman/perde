import CoreImage
import CoreVideo
import Vision

/// What a patch on the overlay is hiding.
enum DetectionKind {
    case text
    case face
}

/// Turns captured frames into the boxes to cover. Frames arrive on a capture queue; each display
/// is scanned by at most one task at a time and always ends on its most recent frame.
final class FrameScanner {
    struct FaceResult {
        let box: CGRect // Normalised, bottom-left origin.
        let nearest: (name: String, distance: Float)? // nil when face-api found no face in the crop.
        let matched: Bool
    }

    /// Called on the main actor with the boxes (normalised, bottom-left origin) found on one display.
    var onDetections: (@MainActor (CGDirectDisplayID, DetectionKind, [CGRect]) -> Void)?

    private struct RecentFace {
        let box: CGRect
        let matched: Bool
        let checked: Date
    }

    private let faceMatcher: FaceMatcher
    private let context = CIContext()
    private let lock = NSLock()
    private var blockList: BlockList?
    private var pending: [CGDirectDisplayID: CVPixelBuffer] = [:]
    private var busy: Set<CGDirectDisplayID> = []
    private var recentFaces: [CGDirectDisplayID: [RecentFace]] = [:]

    // Faces smaller than this in the captured frame give descriptors too noisy to trust.
    private let minimumFaceSide: CGFloat = 40
    private let maximumFacesPerFrame = 8
    // How long a verdict on a face that has not moved is reused before asking face-api again.
    private let faceVerdictLifetime: TimeInterval = 2

    init(faceMatcher: FaceMatcher) {
        self.faceMatcher = faceMatcher
    }

    func setBlockList(_ blockList: BlockList?) {
        lock.withLock {
            self.blockList = blockList
            recentFaces = [:]
        }
    }

    /// Hands over the newest frame of a display. A frame that arrives while the previous one is
    /// still being scanned replaces any other waiting frame instead of queueing behind it.
    func submit(_ buffer: CVPixelBuffer, from display: CGDirectDisplayID) {
        let shouldStart = lock.withLock {
            pending[display] = buffer
            return busy.insert(display).inserted
        }
        guard shouldStart else { return }

        Task.detached(priority: .utility) { [self] in
            while let (buffer, blockList) = nextFrame(for: display) {
                await scan(CIImage(cvPixelBuffer: buffer), on: display, blockList: blockList)
            }
        }
    }

    private func nextFrame(for display: CGDirectDisplayID) -> (CVPixelBuffer, BlockList)? {
        lock.withLock {
            guard let buffer = pending.removeValue(forKey: display), let blockList else {
                busy.remove(display)
                return nil
            }
            return (buffer, blockList)
        }
    }

    private func scan(_ image: CIImage, on display: CGDirectDisplayID, blockList: BlockList) async {
        // Text goes out first: describing faces takes longer and must not delay it.
        let textBoxes = blockList.matcher.map { TextScanner.matchedLines(TextScanner.recognise(image), matcher: $0).map(\.box) } ?? []
        await onDetections?(display, .text, textBoxes)

        guard blockList.faceCount > 0, await faceMatcher.isReady else {
            await onDetections?(display, .face, [])
            return
        }
        let now = Date()
        let known = lock.withLock { recentFaces[display] ?? [] }.filter { now.timeIntervalSince($0.checked) < faceVerdictLifetime }
        var seen: [RecentFace] = []
        for box in candidateFaces(Self.detectFaces(in: image), in: image) {
            if let previous = known.first(where: { Self.overlap($0.box, box) > 0.5 }) {
                seen.append(RecentFace(box: box, matched: previous.matched, checked: previous.checked))
            } else {
                let result = await identify(box, in: image, blockList: blockList)
                seen.append(RecentFace(box: box, matched: result.matched, checked: now))
            }
        }
        lock.withLock { recentFaces[display] = seen }
        await onDetections?(display, .face, seen.filter(\.matched).map(\.box))
    }

    // MARK: Faces

    /// Finds faces with Vision. Vision shrinks the image first and so misses small faces (under
    /// roughly 60 px in a full-screen frame); a second pass over four overlapping quarters finds
    /// them. Boxes are normalised to the whole image, bottom-left origin.
    static func detectFaces(in image: CIImage) -> [CGRect] {
        let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
        let quarters = [0, 0.45].flatMap { x in [0, 0.45].map { y in CGRect(x: x, y: y, width: 0.55, height: 0.55) } }

        var faces: [CGRect] = []
        for region in [whole] + quarters {
            let extent = image.extent
            let tile = CGRect(x: extent.minX + region.minX * extent.width, y: extent.minY + region.minY * extent.height,
                              width: region.width * extent.width, height: region.height * extent.height).integral
            // Cropping by hand rather than with regionOfInterest keeps the box arithmetic explicit.
            let cropped = image.cropped(to: tile).transformed(by: CGAffineTransform(translationX: -tile.minX, y: -tile.minY))
            let request = VNDetectFaceRectanglesRequest()
            try? VNImageRequestHandler(ciImage: cropped).perform([request])

            for found in request.results ?? [] {
                let box = found.boundingBox
                let face = CGRect(x: (tile.minX - extent.minX + box.minX * tile.width) / extent.width,
                                  y: (tile.minY - extent.minY + box.minY * tile.height) / extent.height,
                                  width: box.width * tile.width / extent.width, height: box.height * tile.height / extent.height)
                // The quarters overlap each other and the whole image, so the same face turns up more than once.
                if !faces.contains(where: { overlap($0, face) > 0.3 }) { faces.append(face) }
            }
        }
        return faces
    }

    /// The largest few faces that are big enough to recognise.
    private func candidateFaces(_ boxes: [CGRect], in image: CIImage) -> [CGRect] {
        boxes
            .filter { min($0.width * image.extent.width, $0.height * image.extent.height) >= minimumFaceSide }
            .sorted { $0.width * $0.height > $1.width * $1.height }
            .prefix(maximumFacesPerFrame)
            .map { $0 }
    }

    func identify(_ box: CGRect, in image: CIImage, blockList: BlockList) async -> FaceResult {
        guard let descriptor = await descriptor(forFace: box, in: image),
              let nearest = blockList.nearestFace(to: descriptor) else {
            return FaceResult(box: box, nearest: nil, matched: false)
        }
        return FaceResult(box: box, nearest: nearest, matched: nearest.distance < blockList.faceThreshold)
    }

    func descriptor(forFace box: CGRect, in image: CIImage) async -> [Float]? {
        let extent = image.extent
        let face = VNImageRectForNormalizedRect(box, Int(extent.width), Int(extent.height)).offsetBy(dx: extent.minX, dy: extent.minY)
        // A generous margin: face-api detects and aligns the face again, and needs to see all of it.
        let crop = face.insetBy(dx: -0.6 * face.width, dy: -0.6 * face.height).intersection(extent).integral
        guard !crop.isEmpty else { return nil }

        var cropped = image.cropped(to: crop)
        let scale = min(1, 640 / max(crop.width, crop.height)) // The detector works at 512 px; more is wasted.
        if scale < 1 { cropped = cropped.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        guard let png = context.pngRepresentation(of: cropped, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!) else { return nil }

        // Canvas coordinates start at the top-left; Core Image's at the bottom-left.
        let centre = CGPoint(x: (face.midX - crop.minX) / crop.width, y: (crop.maxY - face.midY) / crop.height)
        return await faceMatcher.descriptor(forFacePNG: png, centre: centre)
    }

    /// Intersection over union of two rectangles.
    static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let intersection = a.intersection(b)
        guard !intersection.isEmpty else { return 0 }
        let shared = intersection.width * intersection.height
        return shared / (a.width * a.height + b.width * b.height - shared)
    }
}
