import SwiftUI
import ServiceManagement
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    @EnvironmentObject private var engine: ReminderEngine
    @EnvironmentObject private var sync: SyncService
    @EnvironmentObject private var calendly: CalendlyService
    @EnvironmentObject private var importer: CalendarImporter
    @State private var calendlyToken = ""
    @State private var syncPassword = ""

    @State private var authStatus: UNAuthorizationStatus = .notDetermined
    @State private var loginItemOn = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?
    @State private var showSecret = false

    var body: some View {
        Form {
            syncSection
            notificationsSection
            nudgeSection
            checkInSection
            reflectionSection
            startupSection
            googleSection
            calendlySection
            importSection
            availabilitySection
            meetingTypesSection
            dataSection
        }
        .formStyle(.grouped)
        .task { authStatus = await Notifier.shared.authorizationStatus() }
    }

    // MARK: Sections

    private var syncSection: some View {
        Section {
            if let user = sync.username {
                HStack {
                    Label("Signed in as \(user)", systemImage: "person.crop.circle.badge.checkmark").foregroundStyle(.green)
                    Spacer()
                    SyncIndicator(prominent: true)
                    Button("Sign out", role: .destructive) { sync.signOut() }
                }
            } else {
                TextField("Username", text: $sync.draftUsername)
                SecureField("Password", text: $syncPassword)
                HStack {
                    if sync.isSigningIn { ProgressView().controlSize(.small) }
                    Spacer()
                    Button("Create account") {
                        Task { await sync.signIn(username: sync.draftUsername, password: syncPassword, create: true); if sync.isSignedIn { syncPassword = "" } }
                    }
                    Button("Sign in") {
                        Task { await sync.signIn(username: sync.draftUsername, password: syncPassword, create: false); if sync.isSignedIn { syncPassword = "" } }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                }
                .disabled(sync.draftUsername.isEmpty || syncPassword.isEmpty || sync.isSigningIn)
                if case .error(let m) = sync.status { Text(m).font(.caption).foregroundStyle(.red) }
                Text("Use the same username and password as on cadenceplanner.vercel.app (or create an account here). You stay signed in on this Mac until you sign out.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Sync with Cadence Web")
        } footer: {
            Text("Tasks, completions, reflections and shared settings sync both ways about every minute and a few seconds after each change. Google sign-in and calendar picks stay on each device.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var notificationsSection: some View {
        Section {
            HStack {
                Label(statusText, systemImage: authStatus == .authorized ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(authStatus == .authorized ? .green : .orange)
                Spacer()
                if authStatus == .notDetermined {
                    Button("Allow notifications") {
                        Task { await Notifier.shared.requestAuthorization(); authStatus = await Notifier.shared.authorizationStatus() }
                    }
                }
                Button("Open Notification Settings") {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
                }
            }
            Text("To make macOS notifications stay on screen until you act on them, set Cadence's style to “Persistent” in System Settings › Notifications. Cadence's own on-screen banners always stay until dismissed.")
                .font(.caption).foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("Default alert style for new tasks").font(.callout.weight(.medium))
                ChannelToggles(channels: $store.settings.defaultChannels, showDetail: true)
            }
            Picker("Tasks without a time remind at", selection: $store.settings.untimedReminderMinutes) {
                ForEach(Array(stride(from: 5 * 60, through: 22 * 60, by: 30)), id: \.self) { m in
                    Text(timeString(minutes: m)).tag(m)
                }
            }
            Picker("On-screen banners", selection: $store.settings.bannerAutoDismissSeconds) {
                Text("Stay until dismissed").tag(0)
                Text("Hide after 10 seconds").tag(10)
                Text("Hide after 30 seconds").tag(30)
                Text("Hide after 2 minutes").tag(120)
            }
            HStack {
                Button("Send a test reminder") {
                    Notifier.shared.deliver(AlertContent(kind: .test, title: "Test reminder",
                                                         body: "This is how Cadence reminders will look.",
                                                         symbol: "bell.badge.fill", tint: .blue),
                                            channels: store.settings.defaultChannels)
                }
                Button("Show check-in window") { engine.triggerCheckIn(reason: .manual) }
            }
        } header: {
            Text("Notifications")
        }
    }

    private var nudgeSection: some View {
        Section {
            Toggle("Remind me to check my checklist while I'm using the Mac", isOn: $store.settings.nudgeEnabled)
            if store.settings.nudgeEnabled {
                Picker("Every", selection: $store.settings.nudgeIntervalMinutes) {
                    ForEach([15, 20, 30, 45, 60, 90, 120], id: \.self) { Text("\($0) minutes").tag($0) }
                }
                Toggle("Skip when everything is already done", isOn: $store.settings.nudgeOnlyWhenIncomplete)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Alert style").font(.callout.weight(.medium))
                    ChannelToggles(channels: $store.settings.nudgeChannels)
                }
                Text("Paused while the screen is locked or asleep. Next reminder around \(timeString(engine.nextNudge)).")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            Text("Recurring checklist reminder")
        }
    }

    private var checkInSection: some View {
        Section {
            Toggle("When Cadence starts (including at login)", isOn: $store.settings.checkInOnLaunch)
            Toggle("When the Mac wakes from sleep", isOn: $store.settings.checkInOnWake)
            Toggle("When the screen is unlocked", isOn: $store.settings.checkInOnUnlock)
            Toggle("Only if something is still unchecked", isOn: $store.settings.checkInOnlyWhenIncomplete)
            VStack(alignment: .leading, spacing: 6) {
                Text("Alert style").font(.callout.weight(.medium))
                ChannelToggles(channels: $store.settings.checkInChannels)
            }
        } header: {
            Text("Check-in when you open your computer")
        }
    }

    private var reflectionSection: some View {
        Section {
            Stepper(value: $store.settings.minReflectionWords, in: 20...300, step: 5) {
                Text("Minimum reflection length: \(store.settings.minReflectionWords) words")
            }
            Text("Every checklist item needs a reflection before it can be checked off. The minimum can't go below 20 words.")
                .font(.caption).foregroundStyle(.secondary)
        } header: {
            Text("Reflections")
        }
    }

    private var startupSection: some View {
        Section {
            Toggle("Open Cadence automatically when I log in", isOn: Binding(get: { loginItemOn }, set: setLoginItem))
            if SMAppService.mainApp.status == .requiresApproval {
                Text("macOS needs your approval in System Settings › General › Login Items.")
                    .font(.caption).foregroundStyle(.orange)
            }
            if let loginError { Text(loginError).font(.caption).foregroundStyle(.red) }
            Text("Recommended: reminders only fire while Cadence is running. Closing the window keeps it in the menu bar.")
                .font(.caption).foregroundStyle(.secondary)
        } header: {
            Text("Startup")
        }
    }

    private var googleSection: some View {
        Section {
            if google.isConnected {
                HStack {
                    Label("Connected" + (google.account.map { " as \($0)" } ?? ""), systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Spacer()
                    Button("Refresh") { Task { await google.loadCalendars(); google.reloadEvents() } }
                    Button("Disconnect", role: .destructive) { google.disconnect() }
                }
                Toggle("Show Google events in Cadence calendars", isOn: $store.settings.showGoogleEvents)
                Picker("Remind me before Google events", selection: $store.settings.googleEventReminderMinutes) {
                    Text("Off").tag(0)
                    ForEach([5, 10, 15, 30], id: \.self) { Text("\($0) minutes").tag($0) }
                }
                if !google.calendars.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Calendars to show and check for busy times").font(.callout.weight(.medium))
                        ForEach(google.calendars) { cal in
                            Toggle(isOn: calendarBinding(cal)) {
                                HStack(spacing: 6) {
                                    Circle().fill(cal.colorHex.flatMap(Color.init(hex:)) ?? .blue).frame(width: 9, height: 9)
                                    Text(cal.summary)
                                    if cal.primary { Text("primary").font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("One-time setup (about 5 minutes):").font(.callout.weight(.medium))
                    Text("1. Open Google Cloud Console, create a project, and enable the **Google Calendar API**.")
                    Text("2. Under **OAuth consent screen**, choose External and add your Google account as a test user.")
                    Text("3. Under **Credentials**, create an **OAuth client ID** with application type **Desktop app**.")
                    Text("4. Paste the Client ID and Client secret below, then Connect.")
                    Link("Open Google Cloud Console", destination: URL(string: "https://console.cloud.google.com/apis/credentials")!)
                }
                .font(.callout)
                TextField("Client ID", text: $store.settings.googleClientID, prompt: Text("…apps.googleusercontent.com"))
                HStack {
                    if showSecret {
                        TextField("Client secret", text: $store.settings.googleClientSecret)
                    } else {
                        SecureField("Client secret", text: $store.settings.googleClientSecret)
                    }
                    Button { showSecret.toggle() } label: { Image(systemName: showSecret ? "eye.slash" : "eye") }
                        .buttonStyle(.borderless)
                }
                HStack {
                    if google.isSigningIn {
                        ProgressView().controlSize(.small)
                        Text("Finish signing in in your browser…").foregroundStyle(.secondary)
                        Button("Cancel") { google.cancelSignIn() }
                    } else {
                        Button("Connect Google Calendar") { Task { await google.connect() } }
                            .buttonStyle(.borderedProminent)
                            .disabled(store.settings.googleClientID.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            if let err = google.lastError {
                Text(err).font(.caption).foregroundStyle(.red)
            }
        } header: {
            Text("Google Calendar")
        }
    }

    private var calendlySection: some View {
        Section {
            if calendly.isConnected {
                HStack {
                    Label("Connected" + (calendly.userName.map { " as \($0)" } ?? ""), systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Spacer()
                    if calendly.isWorking { ProgressView().controlSize(.small) }
                    Button("Refresh") { Task { await calendly.loadProfile() } }
                    Button("Disconnect", role: .destructive) { calendly.disconnect() }
                }
                if let url = calendly.schedulingURL {
                    HStack {
                        Text(url.absoluteString).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        Spacer()
                        Button("Copy booking page link") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(url.absoluteString, forType: .string)
                        }
                    }
                }
            } else {
                Text("In Calendly, open **Integrations › API & Webhooks**, generate a **Personal Access Token**, and paste it here. Your booked meetings will show up on your checklist (without notifications), and your booking links appear on the Booking page.")
                    .font(.callout)
                Link("Open Calendly API settings", destination: URL(string: "https://calendly.com/integrations/api_webhooks")!)
                HStack {
                    SecureField("Personal Access Token", text: $calendlyToken)
                    Button("Connect") { Task { await calendly.connect(token: calendlyToken); if calendly.isConnected { calendlyToken = ""; await importer.importNow() } } }
                        .buttonStyle(.borderedProminent)
                        .disabled(calendlyToken.trimmingCharacters(in: .whitespaces).isEmpty || calendly.isWorking)
                }
            }
            if let e = calendly.lastError { Text(e).font(.caption).foregroundStyle(.red) }
        } header: {
            Text("Calendly")
        }
    }

    private var importSection: some View {
        Section {
            Toggle("Import Google Calendar events and Calendly meetings onto my checklist", isOn: $store.settings.autoImportCalendars)
            Stepper("Import the next \(store.settings.importDaysAhead) days", value: $store.settings.importDaysAhead, in: 1...60)
            HStack {
                Button {
                    Task { await importer.importNow() }
                } label: {
                    Label(importer.isImporting ? "Importing…" : "Import now", systemImage: "square.and.arrow.down")
                }
                .disabled(importer.isImporting || !(google.isConnected || calendly.isConnected))
                if importer.isImporting { ProgressView().controlSize(.small) }
                Spacer()
                if let s = importer.lastSummary { Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
            Text("Imported items never notify you (you can turn notifications on for any single one in its editor). Deleting one hides it for good. Google Calendar is re-checked every 2 minutes (and when Cadence comes to the front), so edits, moves and deletions there show up here quickly; Calendly every 30 minutes.")
                .font(.caption).foregroundStyle(.secondary)
        } header: {
            Text("Calendar imports")
        }
    }

    private var availabilitySection: some View {
        Section {
            WeekdayPicker(selection: $store.settings.availability.weekdays)
            Picker("From", selection: $store.settings.availability.startMinutes) {
                ForEach(Array(stride(from: 6 * 60, through: 20 * 60, by: 30)), id: \.self) { Text(timeString(minutes: $0)).tag($0) }
            }
            Picker("Until", selection: $store.settings.availability.endMinutes) {
                ForEach(Array(stride(from: 8 * 60, through: 23 * 60, by: 30)), id: \.self) { Text(timeString(minutes: $0)).tag($0) }
            }
            Picker("Buffer around meetings", selection: $store.settings.availability.bufferMinutes) {
                ForEach([0, 5, 10, 15, 30], id: \.self) { Text($0 == 0 ? "None" : "\($0) minutes").tag($0) }
            }
            Picker("Minimum notice", selection: $store.settings.availability.minNoticeHours) {
                ForEach([0, 1, 2, 4, 12, 24, 48], id: \.self) { Text($0 == 0 ? "None" : "\($0) hours").tag($0) }
            }
            Stepper("Look ahead \(store.settings.availability.daysAhead) days", value: $store.settings.availability.daysAhead, in: 1...60)
        } header: {
            Text("Booking availability")
        }
    }

    private var meetingTypesSection: some View {
        Section {
            ForEach($store.settings.meetingTypes) { $mt in
                HStack {
                    TextField("Name", text: $mt.name).frame(maxWidth: 180)
                    Picker("", selection: $mt.minutes) {
                        ForEach([15, 20, 30, 45, 60, 90], id: \.self) { Text("\($0) min").tag($0) }
                    }
                    .labelsHidden()
                    .frame(width: 90)
                    TextField("Description", text: $mt.details)
                    Toggle("Meet", isOn: $mt.addMeetLink).help("Add a Google Meet link")
                    Button {
                        store.settings.meetingTypes.removeAll { $0.id == mt.id }
                    } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                        .disabled(store.settings.meetingTypes.count <= 1)
                }
            }
            Button { store.settings.meetingTypes.append(MeetingType(name: "New meeting", minutes: 30)) } label: {
                Label("Add meeting type", systemImage: "plus")
            }
        } header: {
            Text("Meeting types")
        }
    }

    private var dataSection: some View {
        Section {
            HStack {
                Text(store.fileURL.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                Spacer()
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([store.fileURL]) }
            }
            HStack(spacing: 16) {
                Link("Privacy Policy", destination: URL(string: "https://cadenceplanner.vercel.app/privacy")!)
                Link("Terms of Service", destination: URL(string: "https://cadenceplanner.vercel.app/terms")!)
            }
            .font(.caption)
        } header: {
            Text("Data")
        }
    }

    // MARK: Helpers

    private var statusText: String {
        switch authStatus {
        case .authorized: return "Notifications are allowed"
        case .provisional: return "Notifications are delivered quietly"
        case .denied: return "Notifications are turned off for Cadence — on-screen banners are used instead"
        default: return "Notification permission not requested yet"
        }
    }

    private func setLoginItem(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginError = nil
        } catch {
            loginError = error.localizedDescription
        }
        loginItemOn = SMAppService.mainApp.status == .enabled
    }

    private func calendarBinding(_ cal: GCalendar) -> Binding<Bool> {
        Binding(get: {
            let ids = store.settings.googleCalendarIDs
            return ids.isEmpty ? cal.primary : ids.contains(cal.id)
        }, set: { on in
            var ids = store.settings.googleCalendarIDs
            if ids.isEmpty, let primary = google.calendars.first(where: \.primary) { ids = [primary.id] }
            if on { if !ids.contains(cal.id) { ids.append(cal.id) } } else { ids.removeAll { $0 == cal.id } }
            store.settings.googleCalendarIDs = ids
            google.reloadEvents()
        })
    }
}
