import AppKit
import ScreenCaptureKit

/// The menu-bar app: owns the status item and decides when screen capture runs.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private enum CaptureState {
        case stopped
        case running(displays: Int)
        case failed(String)
    }

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let overlay = OverlayController()
    private let capture = ScreenCapture()
    private let faceMatcher = FaceMatcher()
    private lazy var scanner = FrameScanner(faceMatcher: faceMatcher)

    private var blockList = BlockList.LoadResult.missing
    private var captureState = CaptureState.stopped
    private var watcher: BlockListWatcher?
    private var permissionTimer: Timer?

    // Capture is started and stopped by one task at a time; these record what changed meanwhile.
    private var isReconciling = false
    private var needsReconcile = false
    private var needsRestart = false

    private var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "enabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "enabled") }
    }

    private var loadedList: BlockList? {
        if case .loaded(let list) = blockList { list } else { nil }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu

        scanner.onDetections = { [weak self] display, kind, boxes in
            guard let self, case .running = self.captureState else { return } // A scan can finish after capture stopped.
            self.overlay.show(boxes, kind: kind, on: display)
        }
        capture.onFrame = { [scanner] display, buffer in scanner.submit(buffer, from: display) }
        capture.onStop = { [weak self] error in self?.captureStopped(error) }
        faceMatcher.onStateChange = { [weak self] state in
            if case .ready = state { self?.rescan() } // Faces on screen right now have not been checked yet.
        }

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.overlay.rebuildWindows()
                self?.rescan()
            }
        }
        // Streams do not always survive sleep; start afresh on wake.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rescan() }
        }

        // The folder is created up front so that it can be watched and so the user has somewhere to put the file.
        let folder = BlockList.fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        watcher = BlockListWatcher(file: BlockList.fileURL) { [weak self] in self?.reloadBlockList() }

        overlay.rebuildWindows()
        reloadBlockList()
    }

    // MARK: State

    @objc private func reloadBlockList() {
        blockList = BlockList.load()
        scanner.setBlockList(loadedList)
        // The web view and its models cost memory, so they are loaded only once there are faces to compare.
        if let list = loadedList, list.faceCount > 0 { faceMatcher.start() }
        rescan()
    }

    /// A still screen produces no new frames, so after a change in what to look for the streams
    /// are restarted: every stream begins with a full frame.
    private func rescan() {
        needsRestart = true
        reconcile()
    }

    /// Brings capture in line with what it should be doing: running only while enabled, permitted
    /// and given something to look for.
    private func reconcile() {
        updateIcon()
        guard !isReconciling else {
            needsReconcile = true
            return
        }
        isReconciling = true
        Task {
            repeat {
                needsReconcile = false
                let hasPermission = CGPreflightScreenCaptureAccess()
                let shouldRun = isEnabled && hasPermission && loadedList?.isEmpty == false

                if capture.isRunning, !shouldRun || needsRestart {
                    await capture.stop()
                    captureState = .stopped
                    overlay.clear()
                }
                needsRestart = false
                if !shouldRun, case .failed = captureState { captureState = .stopped }
                if shouldRun, !capture.isRunning {
                    do {
                        captureState = .running(displays: try await capture.start(excludingWindows: overlay.windowIDs))
                    } catch {
                        captureState = .failed(error.localizedDescription)
                    }
                }
                watchForPermission(isEnabled && loadedList?.isEmpty == false && !hasPermission)
            } while needsReconcile
            isReconciling = false
        }
    }

    private func captureStopped(_ error: Error) {
        overlay.clear()
        captureState = .failed(error.localizedDescription)
        if (error as NSError).code == SCStreamError.userStopped.rawValue {
            isEnabled = false // The user ended it from the system's screen-sharing menu; respect that.
        }
        Task {
            try? await Task.sleep(for: .seconds(3)) // Displays going to sleep or being unplugged settle shortly.
            rescan()
        }
    }

    /// Screen Recording permission can be granted while the app runs. While it is the only thing
    /// missing, poll for it rather than ask for a relaunch.
    private func watchForPermission(_ missing: Bool) {
        if missing, permissionTimer == nil {
            permissionTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    if CGPreflightScreenCaptureAccess() { self?.reconcile() }
                }
            }
        } else if !missing {
            permissionTimer?.invalidate()
            permissionTimer = nil
        }
    }

    private func updateIcon() {
        let name = isEnabled ? "curtains.closed" : "curtains.open"
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "Perde")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.title = image == nil ? "Perde" : ""
    }

    // MARK: Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let enabled = menu.addItem(withTitle: "Enabled", action: #selector(toggleEnabled), keyEquivalent: "")
        enabled.target = self
        enabled.state = isEnabled ? .on : .off
        menu.addItem(.separator())

        menu.addItem(info(blockListStatus))
        menu.addItem(info(faceStatus))
        if CGPreflightScreenCaptureAccess() {
            menu.addItem(info(captureStatus))
        } else {
            menu.addItem(info("Perde needs Screen Recording permission to see the screen."))
            let grant = menu.addItem(withTitle: "Grant Screen Recording Permission…", action: #selector(requestPermission), keyEquivalent: "")
            grant.target = self
        }
        menu.addItem(.separator())

        let reload = menu.addItem(withTitle: "Reload Block List", action: #selector(reloadBlockList), keyEquivalent: "r")
        reload.target = self
        let open = menu.addItem(withTitle: "Open Block List Folder", action: #selector(openFolder), keyEquivalent: "")
        open.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Perde", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    private func info(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private var blockListStatus: String {
        switch blockList {
        case .missing: "No block list found (perde-blocklist.json)"
        case .invalid(let reason): "Block list cannot be read: \(reason)"
        case .loaded(let list): "Block list: \(count(list.entries.count, "name")), \(count(list.faceCount, "face reference"))"
        }
    }

    private var faceStatus: String {
        guard let list = loadedList, list.faceCount > 0 else { return "Face matching: no face references" }
        return switch faceMatcher.state {
        case .idle, .loading: "Face matching: preparing (can take a minute on first launch)…"
        case .ready: "Face matching: on"
        case .unavailable(let reason): "Face matching unavailable, text only (\(reason))"
        }
    }

    private var captureStatus: String {
        switch captureState {
        case .running(let displays): "Watching \(count(displays, "display"))"
        case .failed(let reason): "Screen capture failed: \(reason)"
        case .stopped: isEnabled ? "Not watching: nothing to look for" : "Not watching: disabled"
        }
    }

    private func count(_ number: Int, _ noun: String) -> String {
        "\(number) \(noun)\(number == 1 ? "" : "s")"
    }

    // MARK: Actions

    @objc private func toggleEnabled() {
        isEnabled.toggle()
        reconcile()
    }

    @objc private func requestPermission() {
        // Only ever called from this menu item: the system prompt should appear because the user asked for it.
        CGRequestScreenCaptureAccess()
    }

    @objc private func openFolder() {
        let folder = BlockList.fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }
}

/// Calls back (on the main queue) when the block list file is created, replaced, edited or removed.
final class BlockListWatcher {
    private let file: URL
    private let onChange: @MainActor () -> Void
    private var sources: [DispatchSourceFileSystemObject] = []
    private var pending: DispatchWorkItem?

    init(file: URL, onChange: @escaping @MainActor () -> Void) {
        self.file = file
        self.onChange = onChange
        watch()
    }

    /// Watches the folder (the file appearing, or being swapped by an atomic save) and the file
    /// itself (edits in place). The file's source dies with the old file, so both are set up again
    /// after every change.
    private func watch() {
        sources.forEach { $0.cancel() }
        sources = [file.deletingLastPathComponent(), file].compactMap { url in
            let descriptor = open(url.path, O_EVTONLY)
            guard descriptor >= 0 else { return nil }
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .extend, .delete, .rename], queue: .main)
            source.setEventHandler { [weak self] in self?.changed() }
            source.setCancelHandler { close(descriptor) }
            source.resume()
            return source
        }
    }

    private func changed() {
        // One save produces a burst of events; wait for it to finish.
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.watch()
            MainActor.assumeIsolated { self.onChange() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }
}
