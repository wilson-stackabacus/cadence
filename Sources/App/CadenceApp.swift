import SwiftUI
import AppKit

@main
struct CadenceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @ObservedObject private var store = AppModel.shared.store

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
                .environmentObject(AppModel.shared)
                .environmentObject(AppModel.shared.store)
                .environmentObject(AppModel.shared.google)
                .environmentObject(AppModel.shared.engine)
                .environmentObject(AppModel.shared.sync)
        } label: {
            let remaining = store.remainingToday
            Image(systemName: remaining > 0 ? "checklist.unchecked" : "checklist.checked")
            if remaining > 0 { Text("\(remaining)") }
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        AppModel.shared.start()
    }

    /// Clicking the Dock icon brings the main window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        AppModel.shared.windows.showMain()
        return true
    }

    /// Closing the window keeps Cadence running in the menu bar so reminders keep working.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.store.saveNow()
    }
}
