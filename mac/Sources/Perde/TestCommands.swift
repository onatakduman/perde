import CoreImage
import Foundation

/// Command-line entry points that exercise the text and face paths on image files, so they can
/// be checked without Screen Recording permission.
@MainActor
enum TestCommands {
    private static let usage = """
    Usage:
      Perde                                          run the menu-bar app
      Perde --test-ocr <image> [--blocklist <json>]  recognise text in an image and list the lines that would be covered
      Perde --describe <photo>                       print the 128 number descriptor of the largest face as JSON
      Perde --test-face <photo> [--blocklist <json>] compare each face in a photo with the block list

    The block list defaults to \(BlockList.fileURL.path)
    """

    static func handles(_ arguments: [String]) -> Bool {
        ["--test-ocr", "--describe", "--test-face", "--help", "-h"].contains(arguments.first ?? "")
    }

    static func run(_ arguments: [String]) async -> Int32 {
        guard arguments.count >= 2, let image = loadImage(arguments[1]) else {
            print(usage)
            return arguments.first == "--help" || arguments.first == "-h" ? 0 : 2
        }
        switch arguments[0] {
        case "--test-ocr":
            guard let blockList = loadBlockList(arguments) else { return 2 }
            return testOCR(image, blockList: blockList)
        case "--describe":
            return await describe(image)
        default:
            guard let blockList = loadBlockList(arguments) else { return 2 }
            return await testFace(image, blockList: blockList)
        }
    }

    // MARK: Commands

    private static func testOCR(_ image: CIImage, blockList: BlockList) -> Int32 {
        guard let matcher = blockList.matcher else {
            printError("The block list has no enabled names.")
            return 2
        }
        let lines = TextScanner.recognise(image)
        let matched = TextScanner.matchedLines(lines, matcher: matcher)
        print("\(pixels(image)), \(lines.count) lines recognised, \(matched.count) matched")
        for line in lines {
            let isMatch = matched.contains { $0.box == line.box }
            print("\(isMatch ? "MATCH" : "clean")  \(describe(line.box, in: image))  \"\(line.text)\"")
        }
        return 0
    }

    private static func describe(_ image: CIImage) async -> Int32 {
        guard let scanner = await readyScanner() else { return 1 }
        let faces = FrameScanner.detectFaces(in: image)
        guard let largest = faces.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
            printError("No face found in the image.")
            return 1
        }
        guard let descriptor = await scanner.descriptor(forFace: largest, in: image) else {
            printError("face-api found no face in the crop around \(describe(largest, in: image)).")
            return 1
        }
        print("[" + descriptor.map { String($0) }.joined(separator: ",") + "]")
        return 0
    }

    private static func testFace(_ image: CIImage, blockList: BlockList) async -> Int32 {
        guard blockList.faceCount > 0 else {
            printError("The block list has no face references.")
            return 2
        }
        guard let scanner = await readyScanner() else { return 1 }
        let faces = FrameScanner.detectFaces(in: image)
        print("\(pixels(image)), \(faces.count) faces detected, threshold \(blockList.faceThreshold)")
        for box in faces {
            let result = await scanner.identify(box, in: image, blockList: blockList)
            let verdict = switch result.nearest {
            case .some(let nearest) where result.matched: "MATCH     \"\(nearest.name)\" at distance \(format(nearest.distance))"
            case .some(let nearest): "no match  nearest is \"\(nearest.name)\" at distance \(format(nearest.distance))"
            case .none: "no match  face-api found no face in the crop"
            }
            print("\(verdict)  \(describe(box, in: image))")
        }
        return 0
    }

    // MARK: Helpers

    private static func readyScanner() async -> FrameScanner? {
        let matcher = FaceMatcher()
        matcher.start()
        await matcher.waitUntilSettled()
        guard case .ready(let backend) = matcher.state else {
            printError("Face matching is unavailable: \(matcher.state)")
            return nil
        }
        printError("face-api ready (TensorFlow.js backend: \(backend))")
        return FrameScanner(faceMatcher: matcher)
    }

    private static func loadImage(_ path: String) -> CIImage? {
        let image = CIImage(contentsOf: URL(fileURLWithPath: path), options: [.applyOrientationProperty: true])
        if image == nil { printError("Cannot read image: \(path)") }
        return image
    }

    private static func loadBlockList(_ arguments: [String]) -> BlockList? {
        var url = BlockList.fileURL
        if let flag = arguments.firstIndex(of: "--blocklist"), flag + 1 < arguments.count {
            url = URL(fileURLWithPath: arguments[flag + 1])
        }
        switch BlockList.load(from: url) {
        case .loaded(let list):
            return list
        case .missing:
            printError("Block list not found: \(url.path)")
        case .invalid(let reason):
            printError("Block list cannot be read: \(reason)")
        }
        return nil
    }

    private static func pixels(_ image: CIImage) -> String {
        "image \(Int(image.extent.width))x\(Int(image.extent.height)) px"
    }

    /// The box in pixels from the top-left corner, which is how image viewers report positions.
    private static func describe(_ box: CGRect, in image: CIImage) -> String {
        let width = image.extent.width, height = image.extent.height
        let values = [box.minX * width, (1 - box.maxY) * height, box.width * width, box.height * height].map { Int($0.rounded()) }
        return "[x=\(values[0]) y=\(values[1]) w=\(values[2]) h=\(values[3])]"
    }

    private static func format(_ distance: Float) -> String {
        String(format: "%.3f", distance)
    }

    private static func printError(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
    }
}
