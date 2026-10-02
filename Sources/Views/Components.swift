import SwiftUI

// MARK: - Layout helpers

struct ScreenHeader<Trailing: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title2.bold())
                if let subtitle { Text(subtitle).foregroundStyle(.secondary) }
            }
            Spacer()
            trailing
        }
        .padding(.horizontal, 22)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }
}

extension ScreenHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle) { EmptyView() }
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
    }
}

struct SectionTitle: View {
    let text: String
    var symbol: String?
    var count: Int?
    var body: some View {
        HStack(spacing: 6) {
            if let symbol { Image(systemName: symbol).foregroundStyle(.secondary) }
            Text(text).font(.headline)
            if let count { Text("\(count)").font(.caption.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
                .background(Capsule().fill(Color.secondary.opacity(0.15))) }
            Spacer()
        }
    }
}

struct ProgressRing: View {
    let done: Int
    let total: Int
    var size: CGFloat = 56
    var lineWidth: CGFloat = 7

    var fraction: Double { total == 0 ? 1 : Double(done) / Double(total) }

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.18), lineWidth: lineWidth)
            Circle().trim(from: 0, to: fraction)
                .stroke(fraction >= 1 ? Color.green : Color.accentColor,
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.spring(duration: 0.5), value: fraction)
            if size >= 44 {
                Text(total == 0 ? "–" : "\(done)/\(total)")
                    .font(.system(size: size * 0.24, weight: .semibold, design: .rounded))
                    .monospacedDigit()
            }
        }
        .frame(width: size, height: size)
    }
}

func setBinding<T: Hashable>(_ set: Binding<Set<T>>, _ value: T) -> Binding<Bool> {
    Binding(get: { set.wrappedValue.contains(value) },
            set: { on in if on { set.wrappedValue.insert(value) } else { set.wrappedValue.remove(value) } })
}

struct ChannelToggles: View {
    @Binding var channels: Set<AlertChannel>
    var showDetail = false
    var body: some View {
        ForEach(AlertChannel.allCases) { ch in
            Toggle(isOn: setBinding($channels, ch)) {
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ch.label)
                        if showDetail { Text(ch.detail).font(.caption).foregroundStyle(.secondary) }
                    }
                } icon: { Image(systemName: ch.symbol) }
            }
        }
    }
}

// MARK: - Checklist rows

struct CheckButton: View {
    let done: Bool
    let color: Color
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: done ? "checkmark.circle.fill" : (hovering ? "checkmark.circle" : "circle"))
                .font(.system(size: 19))
                .foregroundStyle(done ? color : Color.secondary)
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: done)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(done ? "Mark as not done" : "Complete — you'll write a short reflection first")
    }
}

struct ChecklistRow: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    let occ: Occurrence
    var compact = false
    var showDate = false
    /// Defaults to the main-window behaviour (reflection sheet).
    var onToggle: ((Occurrence) -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            CheckButton(done: occ.isDone, color: occ.task.color.color) {
                if let onToggle { onToggle(occ) } else { model.toggle(occ) }
            }
            if !compact {
                RoundedRectangle(cornerRadius: 2).fill(occ.task.color.color).frame(width: 3, height: 30)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(occ.task.title)
                    .strikethrough(occ.isDone)
                    .foregroundStyle(occ.isDone ? .secondary : .primary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    if showDate || occ.isOverdue {
                        Text(occ.day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                            .foregroundStyle(occ.isOverdue ? .red : .secondary)
                    }
                    if let s = occ.start {
                        Label(timeString(s), systemImage: "clock")
                    } else if !compact {
                        Label("Any time", systemImage: "sun.horizon")
                    }
                    if occ.task.recurrence.isRepeating && !compact {
                        Label(occ.task.recurrence.summary(start: occ.task.startDate), systemImage: "repeat")
                            .lineLimit(1)
                    }
                    if occ.isOverdue { Text("Overdue").foregroundStyle(.red).fontWeight(.medium) }
                    if occ.task.source == "calendly" { Label("Calendly", systemImage: "person.2") }
                    if occ.task.source == "google" { Label("Google", systemImage: "calendar") }
                    if occ.task.isSilent { Image(systemName: "bell.slash").help("No notifications") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(CompactLabelStyle())
            }
            Spacer(minLength: 4)
            if occ.isDone && store.reflection(for: occ) != nil {
                Image(systemName: "text.quote").foregroundStyle(.secondary).help("Reflection saved")
            }
        }
        .padding(.vertical, compact ? 3 : 6)
        .contentShape(Rectangle())
        .contextMenu { OccurrenceMenu(occ: occ) }
    }
}

struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon.imageScale(.small); configuration.title }
    }
}

struct OccurrenceMenu: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    let occ: Occurrence

    var body: some View {
        if occ.isDone {
            Button("Mark as not done") { store.uncomplete(occ) }
        } else {
            Button("Complete with reflection…") { model.beginReflection(occ) }
        }
        Button("Edit task…") { model.edit(occ.task) }
        if occ.task.recurrence.isRepeating {
            Button("Skip this occurrence") { store.skip(occ) }
        }
        Divider()
        Button("Delete task", role: .destructive) { store.delete(taskID: occ.task.id) }
    }
}

// MARK: - Reflection form

struct ReflectionForm: View {
    let occurrence: Occurrence
    let minWords: Int
    let onSubmit: (String) -> Void
    let onCancel: () -> Void

    @State private var text = ""
    @FocusState private var focused: Bool

    private static let prompts = [
        "What went well, and why?",
        "What got in the way or felt harder than expected?",
        "What will you do differently next time?",
        "How did this move you toward a bigger goal?",
        "What did you learn about how you work?",
    ]

    private var count: Int { countWords(text) }
    private var ready: Bool { count >= minWords }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: "text.quote")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Circle().fill(occurrence.task.color.color.gradient))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reflect to complete").font(.title3.bold())
                    Text("\(occurrence.task.title) · \(occurrence.day.formatted(.dateTime.weekday(.wide).month().day()))")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Write at least \(minWords) words before checking this off. Some prompts:")
                    .font(.callout)
                ForEach(promptsFor(occurrence), id: \.self) { p in
                    Label(p, systemImage: "circle.fill").labelStyle(BulletLabelStyle())
                        .font(.callout).foregroundStyle(.secondary)
                }
            }

            ZStack(alignment: .topLeading) {
                TextEditor(text: $text)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .focused($focused)
                if text.isEmpty {
                    Text("How did it go?")
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
            }
            .frame(minHeight: 170)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Color.accentColor.opacity(0.6) : Color.primary.opacity(0.12)))

            HStack(spacing: 10) {
                ProgressView(value: Double(min(count, minWords)), total: Double(minWords))
                    .frame(width: 110)
                    .tint(ready ? .green : .accentColor)
                Text("\(count) / \(minWords) words")
                    .monospacedDigit()
                    .foregroundStyle(ready ? .green : .secondary)
                Spacer()
                Button("Cancel", role: .cancel, action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button {
                    onSubmit(text.trimmingCharacters(in: .whitespacesAndNewlines))
                } label: {
                    Label("Submit & complete", systemImage: "checkmark")
                }
                .keyboardShortcut(.return, modifiers: .command)
                .buttonStyle(.borderedProminent)
                .disabled(!ready)
                .help(ready ? "⌘↩ to submit" : "Write \(minWords - count) more word\(minWords - count == 1 ? "" : "s")")
            }
        }
        .padding(22)
        .frame(width: 540)
        .onAppear { DispatchQueue.main.async { focused = true } }
    }

    /// Stable per task, so the prompts don't jump around while typing.
    private func promptsFor(_ occ: Occurrence) -> [String] {
        let seed = abs(occ.task.id.hashValue ^ occ.key.hashValue)
        let start = seed % Self.prompts.count
        return (0..<3).map { Self.prompts[(start + $0) % Self.prompts.count] }
    }
}

struct BulletLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.font(.system(size: 4)).alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + 4 }
            configuration.title
        }
    }
}

// MARK: - Calendar items (tasks + Google events)

enum CalendarItem: Identifiable, Hashable {
    case task(Occurrence)
    case google(GoogleEvent)

    var id: String {
        switch self {
        case .task(let o): return "t|" + o.id
        case .google(let e): return "g|" + e.id
        }
    }
    var title: String {
        switch self {
        case .task(let o): return o.task.title
        case .google(let e): return e.title
        }
    }
    var start: Date? {
        switch self {
        case .task(let o): return o.start
        case .google(let e): return e.isAllDay ? nil : e.start
        }
    }
    var end: Date? {
        switch self {
        case .task(let o): return o.end
        case .google(let e): return e.isAllDay ? nil : e.end
        }
    }
    var color: Color {
        switch self {
        case .task(let o): return o.task.color.color
        case .google(let e): return e.color
        }
    }
    var isDone: Bool {
        if case .task(let o) = self { return o.isDone }
        return false
    }
    var isGoogle: Bool {
        if case .google = self { return true }
        return false
    }
    /// Shown as an event (Google event or a Cadence event): no checkbox, calendar styling.
    var isCalendarEvent: Bool {
        if case .task(let o) = self { return o.isEvent }
        return true
    }
}

/// Popover shown when clicking an item on the week or month calendar.
struct ItemDetail: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    let item: CalendarItem
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(item.color).frame(width: 10, height: 10)
                Text(item.title).font(.headline).lineLimit(2)
            }
            switch item {
            case .task(let occ) where occ.isEvent:
                VStack(alignment: .leading, spacing: 4) {
                    Label(occ.day.formatted(.dateTime.weekday(.wide).month().day()), systemImage: "calendar")
                    if let s = occ.start, let e = occ.end {
                        Label("\(timeString(s)) – \(timeString(e))", systemImage: "clock")
                    } else {
                        Label("All day", systemImage: "sun.horizon")
                    }
                    if occ.task.recurrence.isRepeating {
                        Label(occ.task.recurrence.summary(start: occ.task.startDate), systemImage: "repeat")
                    }
                    if !occ.task.notes.isEmpty { Text(occ.task.notes).foregroundStyle(.secondary).padding(.top, 2) }
                    Text("\(occ.task.source == "calendly" ? "From Calendly" : occ.task.source == "google" ? "From Google Calendar" : "Event") · \(occ.task.isSilent ? "no reminders" : "reminds you") · not on your checklist")
                        .font(.caption).foregroundStyle(.secondary).padding(.top, 2)
                }
                .font(.callout)
                HStack {
                    if let u = occ.task.externalURL.flatMap(URL.init(string:)) { Link("Open", destination: u) }
                    Button("Edit…") { dismiss(); DispatchQueue.main.async { model.edit(occ.task) } }
                    Button("Make it a task") {
                        if var t = store.task(occ.task.id) { t.kind = "task"; store.upsert(t) }
                        dismiss()
                    }
                    .help("Put it on your checklist")
                    Button(occ.task.isImported ? "Hide" : "Delete", role: .destructive) { store.delete(taskID: occ.task.id); dismiss() }
                }
                .controlSize(.small)
            case .task(let occ):
                VStack(alignment: .leading, spacing: 4) {
                    Label(occ.day.formatted(.dateTime.weekday(.wide).month().day()), systemImage: "calendar")
                    if let s = occ.start, let e = occ.end {
                        Label("\(timeString(s)) – \(timeString(e))", systemImage: "clock")
                    } else {
                        Label("Any time", systemImage: "sun.horizon")
                    }
                    if occ.task.recurrence.isRepeating {
                        Label(occ.task.recurrence.summary(start: occ.task.startDate), systemImage: "repeat")
                    }
                    if !occ.task.notes.isEmpty { Text(occ.task.notes).foregroundStyle(.secondary).padding(.top, 2) }
                    if let r = store.reflection(for: occ) {
                        Text("“\(r.text)”").italic().foregroundStyle(.secondary).lineLimit(4).padding(.top, 4)
                    }
                }
                .font(.callout)
                HStack {
                    if occ.isDone {
                        Button("Mark not done") { store.uncomplete(occ); dismiss() }
                    } else {
                        Button("Complete…") { dismiss(); DispatchQueue.main.async { model.beginReflection(occ) } }
                            .buttonStyle(.borderedProminent)
                    }
                    Button("Edit…") { dismiss(); DispatchQueue.main.async { model.edit(occ.task) } }
                    if occ.task.recurrence.isRepeating {
                        Button("Skip") { store.skip(occ); dismiss() }
                    }
                    if occ.task.isImported {
                        Button("Make it an event") {
                            if var t = store.task(occ.task.id) { t.kind = "event"; store.upsert(t) }
                            dismiss()
                        }
                        .help("Take it off your checklist")
                    }
                }
                .controlSize(.small)
                AddDuringMenu(item: item, before: dismiss)
                    .menuStyle(.borderlessButton).fixedSize().controlSize(.small)
            case .google(let ev):
                VStack(alignment: .leading, spacing: 4) {
                    Label(ev.start.formatted(.dateTime.weekday(.wide).month().day()), systemImage: "calendar")
                    if !ev.isAllDay { Label("\(timeString(ev.start)) – \(timeString(ev.end))", systemImage: "clock") }
                    if let loc = ev.location { Label(loc, systemImage: "mappin.and.ellipse") }
                    Label("Google Calendar", systemImage: "link").foregroundStyle(.secondary)
                }
                .font(.callout)
                if let link = ev.link {
                    Link("Open in Google Calendar", destination: link).controlSize(.small)
                }
                AddDuringMenu(item: item, before: dismiss)
                    .menuStyle(.borderlessButton).fixedSize().controlSize(.small)
            }
        }
        .padding(14)
        .frame(width: 280, alignment: .leading)
    }
}

/// "Add task during this…" choices for a timed task or event.
struct AddDuringMenu: View {
    @EnvironmentObject private var model: AppModel
    let item: CalendarItem
    var before: () -> Void = {}

    var body: some View {
        if let s = item.start, let e = item.end {
            let len = e.timeIntervalSince(s)
            Menu {
                Button("At its start (\(timeString(s)))") { before(); model.newTask(at: s) }
                if len >= 30 * 60 {
                    let mid = s.addingTimeInterval(len / 2)
                    Button("Halfway through (\(timeString(mid)))") { before(); model.newTask(at: mid) }
                }
                if len >= 30 * 60 {
                    let late = e.adding(minutes: -15)
                    Button("15 min before it ends (\(timeString(late)))") { before(); model.newTask(at: late) }
                }
            } label: {
                Label("Add task during this", systemImage: "plus.square.on.square")
            }
        }
    }
}

// MARK: - Schedule (events only: Cadence events + Google events)

struct ScheduleItem: Identifiable {
    let item: CalendarItem
    let title: String
    let start: Date?
    let end: Date?
    let color: Color
    let source: String?
    let link: URL?
    let notes: String?
    var id: String { item.id }
}

@MainActor
func schedule(on day: Date, store: Store, google: GoogleCalendar) -> [ScheduleItem] {
    let own = store.events(on: day).map { o in
        ScheduleItem(item: .task(o), title: o.task.title, start: o.start, end: o.end, color: o.task.color.color,
                     source: o.task.source, link: o.task.externalURL.flatMap(URL.init(string:)), notes: o.task.notes.isEmpty ? nil : o.task.notes)
    }
    let g = google.events(on: day).map { e in
        ScheduleItem(item: .google(e), title: e.title, start: e.isAllDay ? nil : e.start, end: e.isAllDay ? nil : e.end, color: e.color,
                     source: "google", link: e.link, notes: e.location)
    }
    return (own + g).sorted {
        switch ($0.start, $1.start) {
        case let (a?, b?): return a < b
        case (nil, _?): return true
        default: return false
        }
    }
}

struct EventRow: View {
    let ev: ScheduleItem
    @State private var showing = false
    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 0) {
                if let s = ev.start {
                    Text(timeString(s)).font(.callout.monospacedDigit())
                    if let e = ev.end { Text(timeString(e)).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                } else {
                    Text("All day").font(.callout)
                }
            }
            .frame(width: 66, alignment: .leading)
            RoundedRectangle(cornerRadius: 2).fill(ev.color).frame(width: 3, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(ev.title).fontWeight(.medium).lineLimit(1)
                HStack(spacing: 8) {
                    if ev.source == "calendly" { Label("Calendly", systemImage: "person.2") }
                    if ev.source == "google" { Label("Google", systemImage: "calendar") }
                    if let n = ev.notes { Text(n).lineLimit(1) }
                }
                .font(.caption).foregroundStyle(.secondary).labelStyle(CompactLabelStyle())
            }
            Spacer()
            if let link = ev.link { Link(destination: link) { Image(systemName: "arrow.up.right.square") }.help("Open") }
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .onTapGesture { showing = true }
        .popover(isPresented: $showing, arrowEdge: .trailing) { ItemDetail(item: ev.item) { showing = false } }
    }
}

/// A compact one-line chip for month cells and all-day rows.
struct ItemChip: View {
    let item: CalendarItem
    @State private var showing = false

    var body: some View {
        HStack(spacing: 4) {
            if item.isCalendarEvent {
                Image(systemName: "calendar").font(.system(size: 8, weight: .bold)).foregroundStyle(item.color)
            } else {
                Image(systemName: item.isDone ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 8, weight: .bold)).foregroundStyle(item.color)
            }
            if let s = item.start {
                Text(timeString(s)).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize()
            }
            Text(item.title).font(.system(size: 11)).lineLimit(1)
                .strikethrough(item.isDone)
                .foregroundStyle(item.isDone ? .secondary : .primary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 1.5)
        .background(RoundedRectangle(cornerRadius: 4).fill(item.color.opacity(item.isCalendarEvent ? 0.10 : 0.16)))
        .contentShape(Rectangle())
        .onTapGesture { showing = true }
        .popover(isPresented: $showing, arrowEdge: .trailing) { ItemDetail(item: item) { showing = false } }
    }
}

struct CalendarNav: View {
    let onPrev: () -> Void
    let onToday: () -> Void
    let onNext: () -> Void
    var body: some View {
        HStack(spacing: 4) {
            Button(action: onPrev) { Image(systemName: "chevron.left") }.help("Previous")
            Button("Today", action: onToday)
            Button(action: onNext) { Image(systemName: "chevron.right") }.help("Next")
        }
    }
}
