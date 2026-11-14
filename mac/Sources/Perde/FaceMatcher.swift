import AppKit
import WebKit

/// Computes face descriptors with the same library and models as the extension (face-api.js),
/// hosted in a hidden web view. Descriptors from any other model would not be comparable with
/// the ones stored in the block list.
@MainActor
final class FaceMatcher: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    enum State: Equatable {
        case idle
        case loading
        case ready(backend: String)
        case unavailable(String)
    }

    private(set) var state: State = .idle {
        didSet {
            guard state != oldValue else { return }
            onStateChange?(state)
            if state != .loading {
                waiters.forEach { $0.resume() }
                waiters = []
            }
        }
    }
    var onStateChange: ((State) -> Void)?
    var isReady: Bool { if case .ready = state { true } else { false } }

    private static let scheme = "perde-face"
    private var webView: WKWebView?
    private var hostWindow: NSWindow?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var restarts = 0

    /// Loads the library and models. Safe to call again; it only does work the first time.
    func start() {
        guard state == .idle else { return }
        guard let directory = Self.resourceDirectory() else {
            state = .unavailable("face-api files not found")
            return
        }
        state = .loading

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // WebKit refuses ES modules and fetch() from file://, so the files are served on a private scheme.
        configuration.setURLSchemeHandler(ResourceHandler(directory: directory), forURLScheme: Self.scheme)
        // The content controller keeps `self` alive; the matcher lives as long as the app, so that is fine.
        configuration.userContentController.add(self, name: "perde")

        let frame = NSRect(x: 0, y: 0, width: 1, height: 1)
        let webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        self.webView = webView

        // WebKit treats a web view outside any window as a background page and starves it of CPU
        // and timers. On first launch the WebGL shaders have to be compiled, which took over
        // 90 s that way against 40 s in a window. The window is a single, fully transparent pixel.
        let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .screenSaver // Above everything, so that no other window covers it and sends the page to the background.
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        window.sharingType = .none
        window.contentView = webView
        window.orderFrontRegardless()
        hostWindow = window

        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://app/index.html")!))

        // Stops callers from waiting for ever. A page that finishes loading later still switches the state to ready.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(300))
            if self?.state == .loading { self?.state = .unavailable("face model took too long to load") }
        }
    }

    /// Returns once loading has either succeeded or failed.
    func waitUntilSettled() async {
        guard state == .loading else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    /// The descriptor of the face in a crop, or nil when face-api finds no face there.
    /// `centre` is where the face is expected, as a fraction of the crop from its top-left corner;
    /// with several faces in the crop the one nearest to it is described.
    func descriptor(forFacePNG png: Data, centre: CGPoint) async -> [Float]? {
        guard isReady, let webView else { return nil }
        let arguments: [String: Any] = ["url": "data:image/png;base64," + png.base64EncodedString(), "x": centre.x, "y": centre.y]

        return await withCheckedContinuation { continuation in
            let once = Once()
            webView.callAsyncJavaScript("return await perdeDescribe(url, x, y)", arguments: arguments, in: nil, in: .page) { result in
                guard once.claim() else { return }
                let numbers = (try? result.get()) as? [NSNumber]
                continuation.resume(returning: numbers?.count == BlockEntry.descriptorLength ? numbers?.map(\.floatValue) : nil)
            }
            // A stuck web process must not stall screen scanning for ever.
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                guard once.claim() else { return }
                self?.state = .unavailable("face model stopped responding")
                continuation.resume(returning: nil)
            }
        }
    }

    // MARK: Web view callbacks

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if let backend = body["ready"] as? String {
            state = .ready(backend: backend)
        } else if let error = body["error"] as? String {
            state = .unavailable(error)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        state = .unavailable(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        state = .unavailable(error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        restarts += 1
        guard restarts <= 3 else {
            state = .unavailable("web process keeps crashing")
            return
        }
        state = .loading
        webView.reload()
    }

    // MARK: Resources

    /// Where face-api.esm.js and models/ live: inside the app bundle, or, for a bare `swift build`
    /// binary, in the repository checkout the binary was built from.
    static func resourceDirectory() -> URL? {
        var candidates: [URL] = []
        if let override = ProcessInfo.processInfo.environment["PERDE_FACE_API_DIR"] {
            candidates.append(URL(fileURLWithPath: override))
        }
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent("face-api"))
        }
        var directory = Bundle.main.executableURL?.resolvingSymlinksInPath().deletingLastPathComponent()
        while let current = directory, current.path != "/" {
            candidates.append(current.appendingPathComponent("perde/vendor/face-api"))
            directory = current.deletingLastPathComponent()
        }
        return candidates.first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("face-api.esm.js").path) }
    }

    private static let page = """
    <!doctype html>
    <meta charset="utf-8">
    <script type="module">
      const post = (message) => window.webkit.messageHandlers.perde.postMessage(message);
      try {
        const faceapi = await import('./face-api.esm.js');
        const { tf, nets } = faceapi;
        // By default TensorFlow.js waits for the GPU by polling on a timer, and WebKit slows the
        // timers of a background page to one tick a second: about a second per face. Without
        // the fence API it reads results back synchronously instead (about 30 ms per face).
        tf.env().set('WEBGL_FENCE_API_ENABLED', false);
        await Promise.all([
          nets.ssdMobilenetv1.loadFromUri('/models'),
          nets.faceLandmark68Net.loadFromUri('/models'),
          nets.faceRecognitionNet.loadFromUri('/models'),
        ]);
        const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 });
        const detect = (canvas) => faceapi.detectAllFaces(canvas, options).withFaceLandmarks().withFaceDescriptors();

        // Running every network once on a blank image compiles its WebGL shaders (slow the first
        // time the app runs, cached by the system afterwards) and shows whether WebGL works at
        // all here; if it does not, the slower CPU backend takes over.
        const blank = document.createElement('canvas');
        blank.width = blank.height = 150;
        blank.getContext('2d').fillRect(0, 0, 150, 150);
        const warmUp = async () => {
          await tf.ready();
          await detect(blank);
          await nets.faceLandmark68Net.detectLandmarks(blank);
          await nets.faceRecognitionNet.computeFaceDescriptor(blank);
        };
        try {
          await warmUp();
        } catch {
          await tf.setBackend('cpu');
          await warmUp();
        }

        window.perdeDescribe = async (url, x, y) => {
          const image = new Image();
          image.src = url;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext('2d').drawImage(image, 0, 0);

          const faces = await detect(canvas);
          const offset = (face) => {
            const box = face.detection.box;
            return Math.hypot((box.x + box.width / 2) / canvas.width - x, (box.y + box.height / 2) / canvas.height - y);
          };
          faces.sort((a, b) => offset(a) - offset(b));
          return faces.length ? Array.from(faces[0].descriptor) : null;
        };
        post({ ready: tf.getBackend() });
      } catch (error) {
        post({ error: String(error?.message ?? error) });
      }
    </script>
    """

    /// Serves the page above plus the vendored library and model files.
    private final class ResourceHandler: NSObject, WKURLSchemeHandler {
        private let directory: URL

        init(directory: URL) { self.directory = directory }

        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url else { return }
            let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let data: Data?
            if path == "index.html" {
                data = Data(FaceMatcher.page.utf8)
            } else if path.contains("..") {
                data = nil
            } else {
                data = try? Data(contentsOf: directory.appendingPathComponent(path))
            }
            guard let data else {
                task.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            let types = ["html": "text/html", "js": "text/javascript", "json": "application/json"]
            let headers = [
                "Content-Type": types[url.pathExtension] ?? "application/octet-stream",
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*",
            ]
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            task.didReceive(data)
            task.didFinish()
        }

        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    }

    /// Lets exactly one of two racing callbacks win.
    private final class Once {
        private var claimed = false
        func claim() -> Bool {
            defer { claimed = true }
            return !claimed
        }
    }
}
