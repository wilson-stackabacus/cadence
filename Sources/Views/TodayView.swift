import SwiftUI

struct TodayView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    @EnvironmentObject private var engine: ReminderEngine
    @State private var quickAdd = ""

    var body: some View {
        let today = Date().startOfDay
        let items = store.occurrences(on: today)
        let overdue = store.overdue()
        let all = overdue + items
        let done = all.filter(\.isDone).count
        let events = google.events(on: today)

        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .center, spacing: 18) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(greeting).font(.title3).foregroundStyle(.secondary)
                        Text(today.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                            .font(.largeTitle.bold())
                        Text(statusLine(done: done, total: all.count))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    ProgressRing(done: done, total: all.count, size: 76, lineWidth: 9)
                }

                HStack(spacing: 8) {
                    Image(systemName: "plus.circle.fill").foregroundStyle(Color.accentColor).font(.title3)
                    TextField("Quick add to today — press Return", text: $quickAdd)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .onSubmit(addQuick)
                    if !quickAdd.isEmpty {
                        Button("Add", action: addQuick).controlSize(.small)
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))

                if !overdue.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle(text: "Overdue", symbol: "exclamationmark.circle", count: overdue.count)
                        Card { VStack(spacing: 0) { rows(overdue) } }
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    SectionTitle(text: "Today's checklist", symbol: "checklist", count: items.count)
                    Card {
                        if items.isEmpty {
                            HStack(spacing: 10) {
                                Image(systemName: "sun.max").font(.title2).foregroundStyle(.orange)
                                VStack(alignment: .leading) {
                                    Text("Nothing scheduled for today.")
                                    Text("Add a task above, or press ⌘N for one with a time and repeat schedule.")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 6)
                        } else {
                            VStack(spacing: 0) { rows(items) }
                        }
                    }
                    Text("Checking an item off asks for a reflection of at least \(store.settings.minReflectionWords) words. They're saved under Reflections.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                if google.isConnected && store.settings.showGoogleEvents {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle(text: "On your Google Calendar", symbol: "calendar", count: events.count)
                        Card {
                            if events.isEmpty {
                                Text("No events today.").foregroundStyle(.secondary)
                            } else {
                                VStack(alignment: .leading, spacing: 8) {
                                    ForEach(events) { ev in
                                        HStack(spacing: 10) {
                                            RoundedRectangle(cornerRadius: 2).fill(ev.color).frame(width: 3, height: 26)
                                            Text(ev.isAllDay ? "All day" : "\(timeString(ev.start)) – \(timeString(ev.end))")
                                                .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                                                .frame(width: 150, alignment: .leading)
                                            Text(ev.title).lineLimit(1)
                                            Spacer()
                                            if let link = ev.link {
                                                Link(destination: link) { Image(systemName: "arrow.up.right.square") }
                                                    .help("Open in Google Calendar")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                remindersCard
            }
            .padding(28)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private func rows(_ list: [Occurrence]) -> some View {
        ForEach(Array(list.enumerated()), id: \.element.id) { i, occ in
            if i > 0 { Divider().padding(.leading, 42) }
            ChecklistRow(occ: occ)
        }
    }

    private var remindersCard: some View {
        let s = store.settings
        return HStack(spacing: 14) {
            Image(systemName: "bell.and.waves.left.and.right").font(.title2).foregroundStyle(.indigo)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.nudgeEnabled
                     ? "Checklist reminder every \(s.nudgeIntervalMinutes) min while you're at your Mac"
                     : "Recurring checklist reminders are off")
                    .font(.callout.weight(.medium))
                Text(s.nudgeEnabled
                     ? "Next one around \(timeString(engine.nextNudge)). You'll also get a check-in whenever the Mac wakes or unlocks."
                     : "Turn them on in Settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Check in now") { engine.triggerCheckIn(reason: .manual) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.indigo.opacity(0.08)))
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }

    private func statusLine(done: Int, total: Int) -> String {
        if total == 0 { return "A clear day." }
        if done == total { return "Everything is checked off. Nice work." }
        return "\(total - done) of \(total) left to check off."
    }

    private func addQuick() {
        let title = quickAdd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        store.upsert(PlanTask(title: title, startDate: Date().startOfDay, channels: store.settings.defaultChannels))
        quickAdd = ""
    }
}
