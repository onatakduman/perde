import AppKit

@main
@MainActor
enum PerdeApp {
    private static var delegate: AppDelegate?

    /// Without arguments this is the menu-bar app. The `--test-…` and `--describe` commands run
    /// one part of the pipeline on an image file and exit; they never touch screen capture.
    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let application = NSApplication.shared

        if TestCommands.handles(arguments) {
            application.setActivationPolicy(.prohibited)
            Task {
                exit(await TestCommands.run(arguments))
            }
        } else {
            delegate = AppDelegate()
            application.delegate = delegate
            application.setActivationPolicy(.accessory) // No Dock icon, also when run outside the app bundle.
        }
        application.run() // The test commands need the main loop too: face matching lives in a web view.
    }
}
