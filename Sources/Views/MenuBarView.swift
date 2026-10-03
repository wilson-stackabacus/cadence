import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var engine: ReminderEngine

    var body: some View {
        let items = store.todayChecklist()
        let done = items.filter(\.isDone).count
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Today").font(.headline)
                    Text(items.isEmpty ? "Nothing scheduled" : done == items.count ? "All done" : "\(items.count - done) of \(items.count) left")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                ProgressRing(done: done, total: items.count, size: 30, lineWidth: 4)
            }
            Divider()
            if items.isEmpty {
                Text("Nothing on today's checklist.").foregroundStyle(.secondary).font(.callout)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(items) { ChecklistRow(occ: $0, compact: true) }
                    }
                }
                .frame(maxHeight: 260)
            }
            Divider()
            HStack {
                Button { model.newTask() } label: { Label("New Task", systemImage: "plus") }
                Button { model.newEvent() } label: { Label("New Event", systemImage: "calendar.badge.plus") }
                Button { engine.triggerCheckIn(reason: .manual) } label: { Label("Check In", systemImage: "sun.max") }
                Spacer()
                Button("Open Cadence") { model.openChecklist() }
            }
            .controlSize(.small)
            HStack {
                if store.settings.nudgeEnabled {
                    Text("Next checklist reminder \(timeString(engine.nextNudge))").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }.controlSize(.small).buttonStyle(.borderless)
            }
        }
        .padding(14)
        .frame(width: 340)
    }
}
