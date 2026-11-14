import AppKit

enum OverlayGeometry {
    /// Converts a Vision box (normalised to the captured display, bottom-left origin) into the
    /// rectangle to cover, in the coordinates of a view that fills that display.
    ///
    /// Working in fractions of the display is what makes this independent of the capture size and
    /// of Retina scaling: the frame may be 1x or 2x pixels, the view is always in points, and both
    /// span the same display. AppKit views also have a bottom-left origin, so nothing is flipped.
    static func viewRect(for box: CGRect, kind: DetectionKind, in size: CGSize) -> CGRect {
        let rect = CGRect(x: box.minX * size.width, y: box.minY * size.height, width: box.width * size.width, height: box.height * size.height)
        // Text boxes hug the glyphs; faces need room for hair and chin.
        let padding = kind == .text ? max(4, rect.height * 0.25) : max(rect.width, rect.height) * 0.3
        return rect.insetBy(dx: -padding, dy: -padding).intersection(CGRect(origin: .zero, size: size))
    }
}

/// One transparent, click-through window per display, holding the blur patches.
@MainActor
final class OverlayController {
    private final class Patch {
        let view: NSView
        let kind: DetectionKind
        var lastSeen = Date()
        var isCurrent = true // Seen by the most recent scan of its kind.

        init(view: NSView, kind: DetectionKind) {
            self.view = view
            self.kind = kind
        }
    }

    private var windows: [CGDirectDisplayID: NSWindow] = [:]
    private var patches: [CGDirectDisplayID: [Patch]] = [:]
    private var pruneTimer: Timer?

    // A patch outlives its last sighting by this long, so one missed frame does not make it flicker.
    private let lingerTime: TimeInterval = 1

    var windowIDs: [CGWindowID] { windows.values.map { CGWindowID($0.windowNumber) } }

    /// Creates the windows for the displays that are attached right now, replacing any old ones.
    func rebuildWindows() {
        clear()
        windows.values.forEach { $0.close() }
        windows = [:]

        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = false
            window.ignoresMouseEvents = true
            window.level = .screenSaver
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            window.sharingType = .none // Keep the patches out of screenshots and screen sharing.
            window.setFrame(screen.frame, display: false)
            window.orderFrontRegardless()
            windows[number.uint32Value] = window
        }

        if pruneTimer == nil {
            pruneTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.prune() }
            }
        }
    }

    /// Replaces the patches of one kind on one display with the result of the latest scan.
    func show(_ boxes: [CGRect], kind: DetectionKind, on display: CGDirectDisplayID) {
        guard let content = windows[display]?.contentView else { return }
        let now = Date()
        var reusable = (patches[display] ?? []).filter { $0.kind == kind }
        reusable.forEach { $0.isCurrent = false }

        for box in boxes {
            let rect = OverlayGeometry.viewRect(for: box, kind: kind, in: content.bounds.size)
            // Moving the patch that already covers this spot avoids a second, stale one beside it.
            if let index = reusable.firstIndex(where: { FrameScanner.overlap($0.view.frame, rect) > 0.3 }) {
                let patch = reusable.remove(at: index)
                patch.view.frame = rect
                patch.lastSeen = now
                patch.isCurrent = true
            } else {
                let patch = Patch(view: PatchView(frame: rect), kind: kind)
                content.addSubview(patch.view)
                patches[display, default: []].append(patch)
            }
        }
    }

    func clear() {
        patches.values.joined().forEach { $0.view.removeFromSuperview() }
        patches = [:]
    }

    /// Patches from the latest scan stay for as long as the screen does not change (a still
    /// screen produces no new frames); the others go once their linger time is up.
    private func prune() {
        let now = Date()
        for (display, list) in patches {
            let expired = list.filter { !$0.isCurrent && now.timeIntervalSince($0.lastSeen) > lingerTime }
            guard !expired.isEmpty else { continue }
            expired.forEach { $0.view.removeFromSuperview() }
            patches[display] = list.filter { patch in !expired.contains { $0 === patch } }
        }
    }
}

/// Blurs whatever is behind the overlay window, with a grey veil so large type cannot be read through it.
private final class PatchView: NSVisualEffectView {
    private static let cornerRadius: CGFloat = 8

    // NSVisualEffectView ignores layer corner radii for behind-window blur; a stretchable mask is the supported way.
    private static let mask: NSImage = {
        let side = cornerRadius * 2 + 1
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: cornerRadius, left: cornerRadius, bottom: cornerRadius, right: cornerRadius)
        image.resizingMode = .stretch
        return image
    }()

    override init(frame: NSRect) {
        super.init(frame: frame)
        // `defaults write io.github.perde.mac solidCover -bool YES` swaps the blur for a plain grey box.
        let solid = UserDefaults.standard.bool(forKey: "solidCover")
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active // The overlay is never the key window; without this the blur would switch off.
        maskImage = Self.mask

        let veil = NSView(frame: bounds)
        veil.autoresizingMask = [.width, .height]
        veil.wantsLayer = true
        veil.layer?.backgroundColor = NSColor(white: 0.45, alpha: solid ? 1 : 0.35).cgColor
        veil.layer?.cornerRadius = Self.cornerRadius
        addSubview(veil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }
}
