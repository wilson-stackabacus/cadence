import SwiftUI

/// The window that pops up when you open the computer (and on demand).
struct CheckInView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    let reason: String
    let onClose: () -> Void
    @State private var reflecting: Occurrence?

    var body: some View {
        Group {
            if let occ = reflecting {
                ReflectionForm(occurrence: occ, minWords: store.settings.minReflectionWords) { text in
                    store.complete(occ, reflection: text)
                    withAnimation { reflecting = nil }
                } onCancel: {
                    withAnimation { reflecting = nil }
                }
                .padding(.top, 16)
            } else {
                checklist
            }
        }
        .frame(width: 560, height: 620, alignment: .top)
    }

    private var checklist: some View {
        let items = store.todayChecklist()
        let done = items.filter(\.isDone).count
        let upcoming = schedule(on: Date(), store: store, google: google).filter { ($0.end ?? .distantPast) > Date() && $0.start != nil }
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                Image(systemName: "sun.max.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(.white)
                    .frame(width: 46, height: 46)
                    .background(Circle().fill(Color.orange.gradient))
                VStack(alignment: .leading, spacing: 2) {
                    Text(reason).font(.title2.bold())
                    Text(Date().formatted(.dateTime.weekday(.wide).month(.wide).day()) + " · "
                         + (items.isEmpty ? "nothing scheduled" : done == items.count ? "all done" : "\(items.count - done) left"))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                ProgressRing(done: done, total: items.count, size: 54, lineWidth: 6)
            }
            .padding(.top, 20)

            if items.isEmpty {
                Card {
                    Text("Nothing on today's checklist. Add something so future-you knows the plan.")
                        .foregroundStyle(.secondary)
                }
            } else {
                if done == items.count {
                    Label("Everything is checked off. Nice work.", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                }
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, occ in
                            if i > 0 { Divider().padding(.leading, 42) }
                            ChecklistRow(occ: occ) { o in
                                if o.isDone { store.uncomplete(o) } else { withAnimation { reflecting = o } }
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                }
                .frame(maxHeight: upcoming.isEmpty ? 380 : 270)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.07)))
            }

            if !upcoming.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Still ahead on your calendar").font(.headline)
                    ForEach(upcoming.prefix(4)) { ev in
                        HStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 2).fill(ev.color).frame(width: 3, height: 18)
                            Text(ev.start.map(timeString) ?? "").monospacedDigit().foregroundStyle(.secondary).frame(width: 74, alignment: .leading)
                            Text(ev.title).lineLimit(1)
                        }
                        .font(.callout)
                    }
                }
            }

            Spacer(minLength: 0)
            HStack {
                Button { onClose(); model.newTask() } label: { Label("Add task", systemImage: "plus") }
                Spacer()
                Button("Open Cadence") { onClose(); model.openChecklist() }
                Button("Done for now", action: onClose)
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 20)
    }
}
