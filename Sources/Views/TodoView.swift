import SwiftUI

struct TodoView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case checklist = "Upcoming checklist", tasks = "All tasks"
        var id: String { rawValue }
    }
    enum Range: Int, CaseIterable, Identifiable {
        case week = 7, twoWeeks = 14, month = 31
        var id: Int { rawValue }
        var label: String { self == .week ? "7 days" : self == .twoWeeks ? "14 days" : "31 days" }
    }

    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @State private var mode: Mode = .checklist
    @State private var range: Range = .week
    @State private var showCompleted = true
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "To-Do List", subtitle: "Every task in one place, including each repeat.") {
                Picker("", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(width: 280)
                .labelsHidden()
            }
            HStack(spacing: 12) {
                TextField("Search", text: $search).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                if mode == .checklist {
                    Picker("Show next", selection: $range) {
                        ForEach(Range.allCases) { Text($0.label).tag($0) }
                    }
                    .frame(width: 170)
                    Toggle("Show completed", isOn: $showCompleted)
                }
                Spacer()
                Button { model.newTask() } label: { Label("New Task", systemImage: "plus") }
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 10)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if mode == .checklist { checklist } else { taskList }
                }
                .padding(22)
                .frame(maxWidth: 900, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func matches(_ title: String) -> Bool {
        search.isEmpty || title.localizedCaseInsensitiveContains(search)
    }

    // MARK: Checklist by day

    @ViewBuilder private var checklist: some View {
        let overdue = store.overdue().filter { matches($0.task.title) }
        if !overdue.isEmpty {
            group(title: "Overdue", symbol: "exclamationmark.circle", items: overdue, showDate: true)
        }
        let today = Date().startOfDay
        let days = (0..<range.rawValue).map { today.adding(days: $0) }
        let groups = days.map { day in
            (day, store.occurrences(on: day).filter { matches($0.task.title) && (showCompleted || !$0.isDone) })
        }.filter { !$0.1.isEmpty }
        if groups.isEmpty && overdue.isEmpty {
            emptyState
        }
        ForEach(groups, id: \.0) { day, items in
            group(title: dayTitle(day), symbol: day.isToday ? "sun.max" : "calendar", items: items, showDate: false)
        }
    }

    private func group(title: String, symbol: String, items: [Occurrence], showDate: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                SectionTitle(text: title, symbol: symbol)
                Text("\(items.filter(\.isDone).count)/\(items.count) done").font(.caption).foregroundStyle(.secondary)
            }
            Card {
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { i, occ in
                        if i > 0 { Divider().padding(.leading, 42) }
                        ChecklistRow(occ: occ, showDate: showDate)
                    }
                }
            }
        }
    }

    private func dayTitle(_ day: Date) -> String {
        if day.isToday { return "Today" }
        if Calendar.current.isDateInTomorrow(day) { return "Tomorrow" }
        return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }

    // MARK: Task definitions

    @ViewBuilder private var taskList: some View {
        let tasks = store.tasks.filter { matches($0.title) }
        let repeating = tasks.filter(\.recurrence.isRepeating).sorted { $0.title < $1.title }
        let oneOff = tasks.filter { !$0.recurrence.isRepeating }.sorted { $0.startDate > $1.startDate }
        if tasks.isEmpty { emptyState }
        if !repeating.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionTitle(text: "Recurring", symbol: "repeat", count: repeating.count)
                Card { VStack(spacing: 0) { taskRows(repeating) } }
            }
        }
        if !oneOff.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SectionTitle(text: "One-time", symbol: "1.circle", count: oneOff.count)
                Card { VStack(spacing: 0) { taskRows(oneOff) } }
            }
        }
    }

    @ViewBuilder private func taskRows(_ tasks: [PlanTask]) -> some View {
        ForEach(Array(tasks.enumerated()), id: \.element.id) { i, t in
            if i > 0 { Divider() }
            TaskDefinitionRow(task: t)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "checklist").font(.system(size: 36)).foregroundStyle(.secondary)
            Text(search.isEmpty ? "No tasks yet" : "No matches").font(.title3.weight(.semibold))
            if search.isEmpty {
                Text("Create a task with ⌘N. Tasks can repeat daily, on certain weekdays, monthly or yearly.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 50)
    }
}

private struct TaskDefinitionRow: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    let task: PlanTask
    @State private var confirmDelete = false

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(task.color.color).frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title).font(.body.weight(.medium))
                HStack(spacing: 10) {
                    Label(task.recurrence.summary(start: task.startDate), systemImage: "repeat")
                    Label(task.timeMinutes.map { timeString(minutes: $0) } ?? "Any time", systemImage: "clock")
                    if let next = task.nextOccurrence() {
                        Label("Next: " + next.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()),
                              systemImage: "arrow.forward.circle")
                    } else if !task.recurrence.isRepeating && task.completions.isEmpty && task.startDate.startOfDay < Date().startOfDay {
                        Label("Overdue", systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    } else if !task.completions.isEmpty {
                        Label("Done", systemImage: "checkmark.circle").foregroundStyle(.green)
                    }
                    if task.googleEventID != nil {
                        Label("On Google Calendar", systemImage: "calendar")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(CompactLabelStyle())
            }
            Spacer()
            HStack(spacing: 4) {
                ForEach(task.channels.sorted { $0.rawValue < $1.rawValue }) { ch in
                    Image(systemName: ch.symbol).font(.caption).foregroundStyle(.secondary).help(ch.label)
                }
            }
            if task.recurrence.isRepeating {
                Text("\(task.completions.count) done").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Button("Edit") { model.edit(task) }.controlSize(.small)
            Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                .controlSize(.small)
                .buttonStyle(.borderless)
                .help("Delete task")
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { model.edit(task) }
        .confirmationDialog("Delete “\(task.title)”?", isPresented: $confirmDelete) {
            Button("Delete task", role: .destructive) { store.delete(taskID: task.id) }
        } message: {
            Text("This removes the task and all its repeats. Reflections you've written stay in the Reflections tab.")
        }
    }
}
