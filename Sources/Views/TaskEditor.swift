import SwiftUI

struct TaskEditor: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar

    let isNew: Bool
    @State private var task: PlanTask
    @State private var hasTime: Bool
    @State private var time: Date
    @State private var endMode: Int
    @State private var endDate: Date
    @State private var endCount: Int
    @State private var addToGoogle = false
    @State private var syncGoogle = false
    @State private var syncDefaultApplied = false
    /// Once you pick open/closed yourself, switching Task/Event no longer changes it.
    @State private var busyChosen = false
    @State private var saving = false
    @State private var error: String?
    @State private var confirmDelete = false

    private static let offsetChoices = [0, 5, 10, 15, 30, 60, 120, 1440]
    /// Reminders partway through a timed task (stored as negative offsets).
    private static let duringChoices = [-10, -15, -30, -45, -60, -90]
    private static let durations = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240]

    init(task: PlanTask, isNew: Bool) {
        self.isNew = isNew
        _task = State(initialValue: task)
        _hasTime = State(initialValue: task.timeMinutes != nil)
        _time = State(initialValue: dayAt(task.startDate, minutes: task.timeMinutes ?? 9 * 60))
        switch task.recurrence.end {
        case .never:
            _endMode = State(initialValue: 0); _endDate = State(initialValue: task.startDate.adding(months: 3)); _endCount = State(initialValue: 10)
        case .onDate(let d):
            _endMode = State(initialValue: 1); _endDate = State(initialValue: d); _endCount = State(initialValue: 10)
        case .afterCount(let c):
            _endMode = State(initialValue: 2); _endDate = State(initialValue: task.startDate.adding(months: 3)); _endCount = State(initialValue: c)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(isNew ? (task.isEvent ? "New Event" : "New Task") : (task.isEvent ? "Edit Event" : "Edit Task")).font(.title3.bold())
                Spacer()
                Picker("", selection: Binding(get: { task.isEvent ? "event" : "task" }, set: { k in
                    task.kind = k
                    if !busyChosen { task.busy = k == "event" }   // events start closed, tasks open
                    if k == "event" && isNew {
                        if !hasTime { hasTime = true; time = dayAt(task.startDate, minutes: 9 * 60) }
                        if task.durationMinutes == 30 { task.durationMinutes = 60 }
                        task.reminderOffsets = [10]
                    }
                })) {
                    Label("Task", systemImage: "checklist").tag("task")
                    Label("Event", systemImage: "calendar").tag("event")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 180)
            }
            .padding([.horizontal, .top], 20)
            Text(task.isEvent ? "Events show on your calendars only: no checkbox, no reflection." : "Tasks go on your checklist; checking one off asks for a short reflection.")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)

            Form {
                Section {
                    TextField("Title", text: $task.title, prompt: Text("What do you need to do?"))
                    TextField("Notes", text: $task.notes, prompt: Text("Optional details"), axis: .vertical)
                        .lineLimit(2...5)
                }

                Section("When") {
                    DatePicker("Date", selection: $task.startDate, displayedComponents: .date)
                    Toggle("At a specific time", isOn: $hasTime)
                    if hasTime {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                        Picker("Duration", selection: $task.durationMinutes) {
                            ForEach(Self.durations, id: \.self) { m in
                                Text(m < 60 ? "\(m) min" : (m % 60 == 0 ? "\(m / 60) hr" : "\(m / 60) hr \(m % 60) min")).tag(m)
                            }
                        }
                    }
                }

                Section {
                    Picker("Your time", selection: Binding(get: { task.isBusy }, set: { task.busy = $0; busyChosen = true })) {
                        Label("Closed", systemImage: "lock.fill").tag(true)
                        Label("Open", systemImage: "eye").tag(false)
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Your time")
                } footer: {
                    Text(task.isBusy
                         ? "Blocks this time: it's taken out of your open time on Booking\(task.source == "google" || syncGoogle ? ", and shows as busy in Google Calendar" : "")."
                         : "Just for info: it shows on your calendars, but you're still free to be booked then.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                if !overlaps.isEmpty {
                    Section {
                        ForEach(overlaps, id: \.self) { line in
                            Label(line, systemImage: "square.stack.3d.up").font(.callout)
                        }
                        Text("That's fine: this task's reminders will still fire on time, even in the middle of the other one.")
                            .font(.caption).foregroundStyle(.secondary)
                    } header: {
                        Text("Overlaps with")
                    }
                }

                if task.source == "google" && !isNew {
                    Section("Synced with Google Calendar") {
                        Label("Changes you save here update the event in Google Calendar, and changes made in Google show up here. Repeats are managed in Google Calendar.",
                              systemImage: "arrow.triangle.2.circlepath")
                            .font(.callout)
                        if let u = task.externalURL.flatMap(URL.init(string:)) { Link("Open in Google Calendar", destination: u) }
                    }
                } else {
                Section("Repeat") {
                    Picker("Repeats", selection: $task.recurrence.frequency) {
                        ForEach(Frequency.allCases) { Text($0.label).tag($0) }
                    }
                    if task.recurrence.isRepeating {
                        Stepper(value: $task.recurrence.interval, in: 1...99) {
                            Text(task.recurrence.interval == 1 ? "Every \(task.recurrence.frequency.unit)"
                                 : "Every \(task.recurrence.interval) \(task.recurrence.frequency.unit)s")
                        }
                        if task.recurrence.frequency == .weekly {
                            WeekdayPicker(selection: $task.recurrence.weekdays)
                        }
                        Picker("Ends", selection: $endMode) {
                            Text("Never").tag(0)
                            Text("On a date").tag(1)
                            Text("After a number of times").tag(2)
                        }
                        if endMode == 1 {
                            DatePicker("End date", selection: $endDate, in: task.startDate..., displayedComponents: .date)
                        } else if endMode == 2 {
                            Stepper("\(endCount) times", value: $endCount, in: 1...999)
                        }
                        Text(previewRecurrence.summary(start: task.startDate))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                }

                Section {
                    Toggle(isOn: Binding(get: { !task.channels.isEmpty },
                                         set: { task.channels = $0 ? store.settings.defaultChannels : [] })) {
                        Label(task.channels.isEmpty ? "No notifications — stays on the checklist quietly" : "Notify me about this task",
                              systemImage: task.channels.isEmpty ? "bell.slash" : "bell")
                    }
                    if !task.channels.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], alignment: .leading, spacing: 6) {
                        ForEach(Self.offsetChoices, id: \.self) { off in
                            Toggle(offsetString(off), isOn: setBinding($task.reminderOffsets, off))
                                .toggleStyle(.checkbox)
                        }
                    }
                    if hasTime {
                        Text("During the task").font(.callout.weight(.medium)).padding(.top, 4)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), alignment: .leading)], alignment: .leading, spacing: 6) {
                            ForEach(Self.duringChoices.filter { -$0 < task.durationMinutes }, id: \.self) { off in
                                Toggle(offsetString(off), isOn: setBinding($task.reminderOffsets, off))
                                    .toggleStyle(.checkbox)
                            }
                        }
                    }
                    ChannelToggles(channels: $task.channels)
                    }
                } header: {
                    Text("Reminders")
                } footer: {
                    if task.isImported {
                        Text("Imported from \(task.source == "calendly" ? "Calendly" : "Google Calendar"). Its title and time update on each import.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if !hasTime && !task.channels.isEmpty {
                        Text("Tasks without a time remind at \(timeString(minutes: store.settings.untimedReminderMinutes)) on the day (change in Settings).")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section("Color") {
                    HStack(spacing: 10) {
                        ForEach(TaskColor.allCases) { c in
                            Circle().fill(c.color).frame(width: 22, height: 22)
                                .overlay(Circle().strokeBorder(.white, lineWidth: task.color == c ? 2.5 : 0))
                                .overlay(Circle().strokeBorder(Color.primary.opacity(task.color == c ? 0.5 : 0), lineWidth: 1).padding(-2))
                                .onTapGesture { task.color = c }
                                .help(c.rawValue.capitalized)
                        }
                    }
                }

                if google.isConnected && task.googleEventID == nil && task.source == nil {
                    Section("Google Calendar") {
                        if task.isEvent {
                            Toggle(isOn: $syncGoogle) { Label("Sync with Google Calendar", systemImage: "arrow.triangle.2.circlepath") }
                            Text(syncGoogle ? "Creates it in your Google Calendar\(task.recurrence.isRepeating ? " (with the repeat schedule)" : ""); edits stay in sync both ways."
                                            : "Keep this event in Cadence only.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Toggle("Also add to Google Calendar", isOn: $addToGoogle)
                            if addToGoogle && task.recurrence.isRepeating {
                                Text("The repeat schedule is copied to Google too.").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)

            Divider()
            HStack {
                if !isNew {
                    Button("Delete", role: .destructive) { confirmDelete = true }
                }
                Spacer()
                if saving { ProgressView().controlSize(.small) }
                Button("Cancel") { model.editingTask = nil }.keyboardShortcut(.cancelAction)
                Button(isNew ? (task.isEvent ? "Add Event" : "Add Task") : "Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(task.title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
            }
            .padding(16)
        }
        .frame(width: 560, height: 700)
        .onChange(of: task.recurrence.frequency) { _, f in
            if f == .weekly && task.recurrence.weekdays.isEmpty {
                task.recurrence.weekdays = [Calendar.current.component(.weekday, from: task.startDate)]
            }
        }
        .confirmationDialog(isGoogleSynced ? "Remove “\(task.title)”?" : "Delete “\(task.title)”?", isPresented: $confirmDelete) {
            if isGoogleSynced {
                Button("Hide in Cadence") { store.delete(taskID: task.id); model.editingTask = nil }
                Button("Delete from Google Calendar too", role: .destructive) {
                    let t = task
                    Task {
                        do {
                            try await google.deleteEvent(calendarID: t.sourceCalendar ?? "primary", eventID: t.googleEventID ?? "")
                            store.delete(taskID: t.id)
                            model.editingTask = nil
                        } catch {
                            self.error = "Google Calendar didn't delete it: \(error.localizedDescription)"
                        }
                    }
                }
            } else {
                Button(task.isEvent ? "Delete event" : "Delete task", role: .destructive) {
                    store.delete(taskID: task.id)
                    model.editingTask = nil
                }
            }
        } message: {
            Text(isGoogleSynced ? "This event is synced with Google Calendar." : task.isEvent ? "This can't be undone." : "Reflections you've written for it are kept.")
        }
        .onAppear {
            // New events sync with Google Calendar by default when it's connected.
            if !syncDefaultApplied { syncDefaultApplied = true; syncGoogle = isNew && task.isEvent && google.isConnected }
        }
        .onChange(of: task.kind) { _, _ in if isNew { syncGoogle = task.isEvent && google.isConnected } }
    }

    /// Other timed tasks / Google events this one overlaps on its start day.
    private var overlaps: [String] {
        guard hasTime else { return [] }
        let day = task.startDate.startOfDay
        let start = dayAt(day, minutes: time.minutesSinceMidnight)
        let end = start.adding(minutes: task.durationMinutes)
        var lines: [String] = []
        for occ in store.occurrences(on: day) where occ.task.id != task.id {
            if let s = occ.start, let e = occ.end, s < end, e > start {
                lines.append("\(occ.task.title) · \(timeString(s))–\(timeString(e))")
            }
        }
        for ev in google.events(on: day) where !ev.isAllDay && ev.start < end && ev.end > start {
            lines.append("\(ev.title) · \(timeString(ev.start))–\(timeString(ev.end)) (Google)")
        }
        return lines
    }

    private var isGoogleSynced: Bool { task.source == "google" && task.googleEventID != nil && google.isConnected }

    private var previewRecurrence: Recurrence {
        var r = task.recurrence
        r.end = endMode == 1 ? .onDate(endDate) : endMode == 2 ? .afterCount(endCount) : .never
        return r
    }

    private func save() {
        var t = task
        t.title = t.title.trimmingCharacters(in: .whitespacesAndNewlines)
        t.startDate = t.startDate.startOfDay
        t.timeMinutes = hasTime ? time.minutesSinceMidnight : nil
        t.recurrence = previewRecurrence
        if t.recurrence.frequency != .weekly { t.recurrence.weekdays = [] }
        // "During" reminders only make sense inside a timed task's span.
        t.reminderOffsets = t.reminderOffsets.filter { $0 >= 0 || (t.timeMinutes != nil && -$0 < t.durationMinutes) }
        if t.reminderOffsets.isEmpty { t.reminderOffsets = [0] }
        let start0 = t.timeMinutes.map { dayAt(t.startDate, minutes: $0) } ?? t.startDate
        let googleEvent = NewGoogleEvent(title: t.title, details: t.notes, start: start0,
                                         end: start0.adding(minutes: t.durationMinutes), allDay: t.timeMinutes == nil,
                                         rrule: t.recurrence.rrule(start: t.startDate), busy: t.isBusy)

        // Editing an event synced with Google: save here, then push the change to Google.
        if !isNew, t.source == "google", let eventID = t.googleEventID {
            store.upsert(t)
            model.editingTask = nil
            var update = googleEvent
            update.rrule = nil
            Task { try? await google.update(calendarID: t.sourceCalendar ?? "primary", eventID: eventID, update) }
            return
        }

        // A new event that syncs with Google: create it there first, then keep it as the synced copy
        // (same ID the importer would give it, so it's never imported twice).
        if isNew && t.isEvent && syncGoogle && google.isConnected {
            saving = true
            Task {
                do {
                    let ev = try await google.create(googleEvent)
                    if !t.recurrence.isRepeating, let ev {
                        let raw = ev.id.split(separator: "|", maxSplits: 1).last.map(String.init) ?? ev.id
                        var synced = t
                        synced.id = stableUUID("google:\(raw)")
                        synced.kind = "event"; synced.source = "google"; synced.googleEventID = raw
                        synced.sourceCalendar = ev.calendarID; synced.externalURL = ev.link?.absoluteString
                        store.upsert(synced)
                    } else {
                        // Repeating: Google holds the schedule; its dates arrive with the next import.
                        await model.importer.importNow(includeCalendly: false)
                    }
                    model.editingTask = nil
                } catch {
                    store.upsert(t)
                    self.error = "Saved in Cadence only — Google Calendar failed: \(error.localizedDescription)"
                }
                saving = false
            }
            return
        }

        store.upsert(t)
        guard addToGoogle else { model.editingTask = nil; return }
        saving = true
        Task {
            do {
                let start = t.timeMinutes.map { dayAt(t.startDate, minutes: $0) } ?? t.startDate
                let ev = try await google.create(NewGoogleEvent(
                    title: t.title, details: t.notes, start: start,
                    end: start.adding(minutes: t.durationMinutes), allDay: t.timeMinutes == nil,
                    rrule: t.recurrence.rrule(start: t.startDate), busy: t.isBusy))
                if var latest = store.task(t.id) {
                    latest.googleEventID = ev?.id
                    store.upsert(latest)
                }
                model.editingTask = nil
            } catch {
                self.error = "Saved in Cadence, but Google Calendar failed: \(error.localizedDescription)"
            }
            saving = false
        }
    }
}

struct WeekdayPicker: View {
    @Binding var selection: [Int]

    var body: some View {
        let cal = Calendar.current
        let order = (0..<7).map { (cal.firstWeekday - 1 + $0) % 7 + 1 }
        HStack(spacing: 6) {
            ForEach(order, id: \.self) { wd in
                let on = selection.contains(wd)
                Text(cal.veryShortWeekdaySymbols[wd - 1])
                    .font(.callout.weight(.semibold))
                    .frame(width: 30, height: 30)
                    .foregroundStyle(on ? .white : .primary)
                    .background(Circle().fill(on ? Color.accentColor : Color.secondary.opacity(0.15)))
                    .contentShape(Circle())
                    .onTapGesture {
                        if on { if selection.count > 1 { selection.removeAll { $0 == wd } } }
                        else { selection.append(wd); selection.sort() }
                    }
                    .help(cal.weekdaySymbols[wd - 1])
            }
            Spacer()
            Button("Weekdays") { selection = [2, 3, 4, 5, 6] }.controlSize(.small)
        }
    }
}
