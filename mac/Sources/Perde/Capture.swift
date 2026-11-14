import CoreMedia
import ScreenCaptureKit

/// Captures every display at a low frame rate. Requires Screen Recording permission: calling
/// `start` without it makes the system show its permission prompt.
@MainActor
final class ScreenCapture {
    /// Called on a background queue with each new frame.
    var onFrame: ((CGDirectDisplayID, CVPixelBuffer) -> Void)?
    /// Called on the main actor when the system ends a stream (display removed, permission revoked, user stopped it).
    var onStop: ((Error) -> Void)?

    private(set) var isRunning = false
    private var streams: [DisplayStream] = []

    // Frames per second. Higher means less delay before a patch appears, and more CPU.
    private let frameRate: Int32 = 3
    // Capture size relative to the display's size in points. 1 is half of Retina resolution,
    // which keeps text recognition fast and is still enough for ordinary UI text.
    private let scale: CGFloat = 1

    /// Starts one stream per display and returns how many there are. Windows of this app (the
    /// overlay) are left out, otherwise the patches would hide the very text they are tracking.
    func start(excludingWindows windowIDs: [CGWindowID]) async throws -> Int {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let ownApps = content.applications.filter { $0.processID == getpid() }
        let ownWindows = content.windows.filter { windowIDs.contains($0.windowID) }

        var started: [DisplayStream] = []
        do {
            for display in content.displays {
                let filter = ownApps.isEmpty
                    ? SCContentFilter(display: display, excludingWindows: ownWindows)
                    : SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])

                let configuration = SCStreamConfiguration()
                configuration.width = Int(CGFloat(display.width) * scale)
                configuration.height = Int(CGFloat(display.height) * scale)
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: frameRate)
                configuration.pixelFormat = kCVPixelFormatType_32BGRA
                configuration.showsCursor = false
                configuration.queueDepth = 5 // The scanner holds on to up to two frames per display.

                let stream = DisplayStream(displayID: display.displayID, filter: filter, configuration: configuration)
                stream.onFrame = onFrame
                stream.onStop = { [weak self] error in
                    Task { @MainActor in
                        // Streams also report an error when they are stopped on purpose.
                        guard let self, self.isRunning else { return }
                        self.onStop?(error)
                    }
                }
                try await stream.start()
                started.append(stream)
            }
        } catch {
            for stream in started { await stream.stop() }
            throw error
        }
        streams = started
        isRunning = true
        return started.count
    }

    func stop() async {
        let stopping = streams
        streams = []
        isRunning = false
        for stream in stopping { await stream.stop() }
    }
}

private final class DisplayStream: NSObject, SCStreamOutput, SCStreamDelegate {
    var onFrame: ((CGDirectDisplayID, CVPixelBuffer) -> Void)?
    var onStop: ((Error) -> Void)?

    private let displayID: CGDirectDisplayID
    private let queue = DispatchQueue(label: "perde.capture", qos: .utility)
    private var stream: SCStream?

    init(displayID: CGDirectDisplayID, filter: SCContentFilter, configuration: SCStreamConfiguration) {
        self.displayID = displayID
        super.init()
        stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    }

    func start() async throws {
        try stream?.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream?.startCapture()
    }

    func stop() async {
        try? await stream?.stopCapture()
        stream = nil
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // The stream also delivers "nothing changed" frames without pixels; only complete ones are worth scanning.
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
              let buffer = sampleBuffer.imageBuffer else { return }
        onFrame?(displayID, buffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onStop?(error)
    }
}
