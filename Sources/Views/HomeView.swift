import SwiftUI

/// The app's main menu: today at a glance, what's next, and a door into every section.
struct HomeView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    @EnvironmentObject private var sync: SyncService
    @EnvironmentObject private var calendly: CalendlyService
    @EnvironmentObject private var engine: ReminderEngine

    var body: some View {
        let now = Date()
        let items = store.todayChecklist()
        let open = items.filter { !$0.isDone }
        let done = items.count - open.count
        let overdue = store.overdue().count
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header(now: now, open: open.count, total: items.count)
                if !sync.isSignedIn { syncPrompt }
                HStack(alignment: .top, spacing: 14) {
                    todayCard(items: items, open: open, done: done, overdue: overdue)
                        .frame(maxWidth: .infinity)
                    VStack(alignment: .leading, spacing: 14) {
                        upNextCard(now: now)
                        reflectionCard
                    }
                    .frame(width: 300)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                    tile(.week, "\(weekCount(now))", "tasks this week", .blue)
                    tile(.month, now.formatted(.dateTime.month(.abbreviated)), "see the whole month", .teal)
                    tile(.todo, "\(store.tasks.filter { $0.archived != true }.count)", overdue > 0 ? "\(overdue) overdue" : "all your tasks", .orange)
                    tile(.reflections, "\(store.reflections.count)", store.reflectionStreak > 0 ? "\(store.reflectionStreak)-day streak" : "your record", .indigo)
                    tile(.booking, durationText(BookingView.plans(store: store, google: google, busy: []).reduce(0) { $0 + $1.total }), "open in the next 7 days", .green)
                    tile(.settings, sync.isSignedIn ? "Synced" : "Local", google.isConnected ? "Google connected" : "reminders & sync", .gray)
                }
            }
            .padding(28)
            .frame(maxWidth: 980, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: Pieces

    private var syncPrompt: some View {
        HStack(spacing: 14) {
            Image(systemName: "icloud.slash").font(.title2).foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("This Mac isn't syncing").font(.callout.weight(.semibold))
                Text("Sign in with your cadenceplanner.vercel.app account to share tasks and reflections with the web.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Sign in") { model.screen = .settings }.buttonStyle(.borderedProminent)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.orange.opacity(0.10)))
    }

    private func header(now: Date, open: Int, total: Int) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(greeting(now) + (sync.username.map { ", \($0)" } ?? "")).font(.title3).foregroundStyle(.secondary)
                Text(now.formatted(.dateTime.weekday(.wide).month(.wide).day())).font(.largeTitle.bold())
                Text(total == 0 ? "Nothing on your checklist today." : open == 0 ? "Everything is checked off. Nice work." : "\(open) thing\(open == 1 ? "" : "s") left today.")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button { engine.triggerCheckIn(reason: .manual) } label: { Label("Check in", systemImage: "sun.max") }
            Button { model.newEvent() } label: { Label("New Event", systemImage: "calendar") }
            Button { model.newTask() } label: { Label("New Task", systemImage: "plus") }
                .buttonStyle(.borderedProminent)
        }
    }

    private func todayCard(items: [Occurrence], open: [Occurrence], done: Int, overdue: Int) -> some View {
        Button { model.screen = .today } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 16) {
                    ProgressRing(done: done, total: items.count, size: 72, lineWidth: 8)
                    VStack(alignment: .leading, spacing: 2) {
                        Label("Today", systemImage: "sun.max").font(.headline)
                        HStack(spacing: 4) {
                            Text(items.isEmpty ? "A clear day" : "\(done) of \(items.count) done")
                            if overdue > 0 { Text("· \(overdue) overdue").foregroundStyle(.red) }
                        }
                        .font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                }
                if !open.isEmpty {
                    Divider()
                    ForEach(open.prefix(4)) { o in
                        HStack(spacing: 8) {
                            Circle().fill(o.task.color.color).frame(width: 7, height: 7)
                            Text(o.task.title).lineLimit(1)
                            Spacer()
                            Text(o.start.map(timeString) ?? (o.isOverdue ? "overdue" : "any time"))
                                .font(.caption).foregroundStyle(o.isOverdue ? .red : .secondary)
                        }
                        .font(.callout)
                    }
                    if open.count > 4 { Text("+\(open.count - 4) more").font(.caption).foregroundStyle(.secondary) }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
            .contentShape(Rectangle())
        }
        .buttonStyle(LiftButtonStyle())
    }

    private func upNextCard(now: Date) -> some View {
        let tasks = (store.occurrences(on: now) + store.occurrences(on: now.adding(days: 1)))
            .filter { !$0.isDone && ($0.start ?? .distantPast) > now }
            .map { (title: $0.task.title, at: $0.start!, color: $0.task.color.color) }
        let events = google.events(on: now).filter { !$0.isAllDay && $0.start > now }
            .map { (title: $0.title, at: $0.start, color: $0.color) }
        let next = (tasks + events).min { $0.at < $1.at }
        return Card {
            VStack(alignment: .leading, spacing: 6) {
                Label("Up next", systemImage: "clock").font(.headline)
                if let next {
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 2).fill(next.color).frame(width: 4, height: 34)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(next.title).fontWeight(.semibold).lineLimit(1)
                            Text((next.at.isToday ? "" : "Tomorrow · ") + timeString(next.at)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Text("Nothing else scheduled with a time.").font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var reflectionCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 6) {
                Label("Latest reflection", systemImage: "text.quote").font(.headline)
                if let r = store.reflections.max(by: { $0.createdAt < $1.createdAt }) {
                    Text("“\(r.text)”").italic().font(.callout).lineLimit(4)
                    Text(r.taskTitle).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Check something off to write your first one.").font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func tile(_ screen: Screen, _ value: String, _ sub: String, _ hue: Color) -> some View {
        Button { model.screen = screen } label: {
            HStack(spacing: 12) {
                Image(systemName: screen.symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(hue)
                    .frame(width: 38, height: 38)
                    .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(hue.opacity(0.14)))
                VStack(alignment: .leading, spacing: 0) {
                    Text(screen.title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(value).font(.title3.bold()).monospacedDigit()
                    Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
            .contentShape(Rectangle())
        }
        .buttonStyle(LiftButtonStyle())
    }

    private func weekCount(_ now: Date) -> Int {
        let start = now.startOfWeek
        return (0..<7).reduce(0) { $0 + store.checklist(on: start.adding(days: $1)).count }
    }

    private func greeting(_ now: Date) -> String {
        switch Calendar.current.component(.hour, from: now) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }
}

/// Cards that lift on hover and press down when clicked.
struct LiftButtonStyle: ButtonStyle {
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .offset(y: hovering && !configuration.isPressed ? -2 : 0)
            .shadow(color: .black.opacity(hovering ? 0.12 : 0), radius: 12, y: 6)
            .animation(.easeOut(duration: 0.15), value: hovering)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .onHover { hovering = $0 }
    }
}
