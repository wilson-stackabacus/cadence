import AppKit
import SwiftUI

enum Screen: String, CaseIterable, Identifiable {
    case today, week, month, todo, reflections, booking, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .today: return "Today"
        case .week: return "Week"
        case .month: return "Month"
        case .todo: return "To-Do List"
        case .reflections: return "Reflections"
        case .booking: return "Booking"
        case .settings: return "Settings"
        }
    }
    var symbol: String {
        switch self {
        case .today: return "sun.max"
        case .week: return "calendar.day.timeline.left"
        case .month: return "calendar"
        case .todo: return "checklist"
        case .reflections: return "text.quote"
        case .booking: return "person.crop.circle.badge.clock"
        case .settings: return "gearshape"
        }
    }
}

/// Owns the app's long-lived objects and the navigation state shared by all windows.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let store: Store
    let google: GoogleCalendar
    let sync: SyncService
    let calendly = CalendlyService()
    private(set) lazy var importer = CalendarImporter(model: self)
    let notifier = Notifier.shared
    let windows = WindowManager()
    private(set) lazy var engine = ReminderEngine(model: self)

    @Published var screen: Screen = .today
    @Published var reflectionTarget: Occurrence?
    @Published var editingTask: PlanTask?

    private init() {
        store = Store(directory: LaunchOptions.dataDirectory)
        google = GoogleCalendar(store: store)
        sync = SyncService(store: store)
    }

    func start() {
        windows.model = self
        notifier.setup(model: self)
        google.restore()
        engine.start()
        sync.start()
        calendly.restore()
        importer.start()
        #if DEBUG
        DebugDriver.prepare(self)
        #endif
        if !LaunchOptions.has("-background") { windows.showMain() }
        if store.settings.checkInOnLaunch && !LaunchOptions.has("-noCheckIn") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.engine.triggerCheckIn(reason: .launch) }
        }
        #if DEBUG
        DebugDriver.run(self)
        #endif
    }

    // MARK: Actions used across views

    func newTask(on day: Date = Date(), minutes: Int? = nil) {
        editingTask = PlanTask(title: "", startDate: day.startOfDay, timeMinutes: minutes,
                               channels: store.settings.defaultChannels)
        windows.showMain()
    }

    /// Start a new task at a moment inside an existing task or event, so its
    /// reminders fire while the other one is still going.
    func newTask(at moment: Date) {
        let m = moment.minutesSinceMidnight / 5 * 5
        newTask(on: moment, minutes: min(m, 23 * 60 + 55))
    }

    func edit(_ task: PlanTask) {
        editingTask = store.task(task.id) ?? task
        windows.showMain()
    }

    /// Completing requires a reflection, so "checking" an item opens the reflection form.
    func toggle(_ occ: Occurrence) {
        if occ.isDone { store.uncomplete(occ) } else { beginReflection(occ) }
    }

    func beginReflection(_ occ: Occurrence) {
        windows.showMain()
        // Re-read the task so the sheet sees the latest state.
        if let t = store.task(occ.task.id) { reflectionTarget = Occurrence(task: t, day: occ.day) }
    }

    func openChecklist() {
        screen = .today
        windows.showMain()
    }
}

enum LaunchOptions {
    static var args: [String] { ProcessInfo.processInfo.arguments }
    static func has(_ flag: String) -> Bool { args.contains(flag) }
    static func value(_ flag: String) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dataDirectory: URL {
        if let custom = value("-dataDir") { return URL(fileURLWithPath: custom, isDirectory: true) }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Cadence", isDirectory: true)
    }
}

/// The main window and check-in window are managed with AppKit so they can be
/// reopened from anywhere (menu bar, notifications, wake events).
@MainActor
final class WindowManager: NSObject, NSWindowDelegate {
    weak var model: AppModel?
    private(set) var mainWindow: NSWindow?
    private(set) var checkInWindow: NSWindow?
    private var checkInReason = ""

    private func inject<V: View>(_ view: V) -> some View {
        let m = model ?? AppModel.shared
        return view.environmentObject(m).environmentObject(m.store).environmentObject(m.google)
            .environmentObject(m.engine).environmentObject(m.sync)
            .environmentObject(m.calendly).environmentObject(m.importer)
    }

    func showMain() {
        if mainWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.title = "Cadence"
            w.titlebarAppearsTransparent = true
            w.isReleasedWhenClosed = false
            w.minSize = NSSize(width: 900, height: 600)
            w.contentViewController = NSHostingController(rootView: inject(RootView()))
            w.setContentSize(NSSize(width: 1180, height: 760))
            w.center()
            w.setFrameAutosaveName("CadenceMain")
            mainWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        mainWindow?.makeKeyAndOrderFront(nil)
    }

    func showCheckIn(reason: String) {
        checkInReason = reason
        let root = inject(CheckInView(reason: reason, onClose: { [weak self] in self?.closeCheckIn() }))
        if let w = checkInWindow {
            (w.contentViewController as? NSHostingController<AnyView>)?.rootView = AnyView(root)
        } else {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 620),
                             styleMask: [.titled, .closable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.isMovableByWindowBackground = true
            w.isReleasedWhenClosed = false
            w.level = .floating
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            w.contentViewController = NSHostingController(rootView: AnyView(root))
            w.setContentSize(NSSize(width: 560, height: 620))
            checkInWindow = w
        }
        checkInWindow?.center()
        NSApp.activate(ignoringOtherApps: true)
        checkInWindow?.makeKeyAndOrderFront(nil)
    }

    func closeCheckIn() {
        checkInWindow?.orderOut(nil)
        model?.engine.resetNudgeTimer()
    }
}
