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
                Text(isNew ? "New Task" : "Edit Task").font(.title3.bold())
                Spacer()
            }
            .padding([.horizontal, .top], 20)

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

                Section {
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
                } header: {
                    Text("Reminders")
                } footer: {
                    if !hasTime {
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

                if google.isConnected && task.googleEventID == nil {
                    Section("Google Calendar") {
                        Toggle("Also add to Google Calendar", isOn: $addToGoogle)
                        if addToGoogle && task.recurrence.isRepeating {
                            Text("The repeat schedule is copied to Google too.").font(.caption).foregroundStyle(.secondary)
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
                Button(isNew ? "Add Task" : "Save") { save() }
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
        .confirmationDialog("Delete “\(task.title)”?", isPresented: $confirmDelete) {
            Button("Delete task", role: .destructive) {
                store.delete(taskID: task.id)
                model.editingTask = nil
            }
        } message: {
            Text("Reflections you've written for it are kept.")
        }
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
        if t.reminderOffsets.isEmpty && !t.channels.isEmpty { t.reminderOffsets = [0] }
        store.upsert(t)

        guard addToGoogle else { model.editingTask = nil; return }
        saving = true
        Task {
            do {
                let start = t.timeMinutes.map { dayAt(t.startDate, minutes: $0) } ?? t.startDate
                let ev = try await google.create(NewGoogleEvent(
                    title: t.title, details: t.notes, start: start,
                    end: start.adding(minutes: t.durationMinutes), allDay: t.timeMinutes == nil,
                    rrule: t.recurrence.rrule(start: t.startDate)))
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
