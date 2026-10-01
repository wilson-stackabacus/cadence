import SwiftUI
import UniformTypeIdentifiers

struct ReflectionsView: View {
    @EnvironmentObject private var store: Store
    @State private var search = ""
    @State private var toDelete: Reflection?

    private var filtered: [Reflection] {
        store.reflections
            .filter { search.isEmpty || $0.text.localizedCaseInsensitiveContains(search) || $0.taskTitle.localizedCaseInsensitiveContains(search) }
            .sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        let groups = Dictionary(grouping: filtered) { $0.createdAt.startOfDay }
            .sorted { $0.key > $1.key }
        VStack(spacing: 0) {
            ScreenHeader(title: "Reflections", subtitle: "A record of what you wrote each time you checked something off.") {
                Button { export() } label: { Label("Export…", systemImage: "square.and.arrow.up") }
                    .disabled(store.reflections.isEmpty)
            }
            HStack(spacing: 12) {
                stat("\(store.reflections.count)", "reflections", "text.quote", .indigo)
                stat("\(store.reflections.reduce(0) { $0 + $1.wordCount })", "words written", "character.cursor.ibeam", .teal)
                stat("\(store.reflectionStreak)", store.reflectionStreak == 1 ? "day streak" : "days streak", "flame", .orange)
                stat("\(Set(store.reflections.map(\.taskID)).count)", "different tasks", "square.stack", .green)
            }
            .padding(.horizontal, 22)
            TextField("Search reflections", text: $search)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 22)
                .padding(.vertical, 12)
            Divider()
            if store.reflections.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "text.quote").font(.system(size: 36)).foregroundStyle(.secondary)
                    Text("No reflections yet").font(.title3.weight(.semibold))
                    Text("Each time you check off a task you'll write a short reflection (at least \(store.settings.minReflectionWords) words). They collect here.")
                        .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(groups, id: \.key) { day, items in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(day.isToday ? "Today" : day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))
                                    .font(.headline)
                                ForEach(items) { r in card(r) }
                            }
                        }
                    }
                    .padding(22)
                    .frame(maxWidth: 860, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .confirmationDialog("Delete this reflection?", isPresented: Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } })) {
            Button("Delete", role: .destructive) { if let r = toDelete { store.deleteReflection(r.id) }; toDelete = nil }
        } message: {
            Text("The task stays checked off. This can't be undone.")
        }
    }

    private func stat(_ value: String, _ label: String, _ symbol: String, _ tint: Color) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.title3).foregroundStyle(tint).frame(width: 26)
            VStack(alignment: .leading, spacing: 0) {
                Text(value).font(.title3.bold()).monospacedDigit()
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 10).fill(tint.opacity(0.08)))
    }

    private func card(_ r: Reflection) -> some View {
        let color = store.task(r.taskID)?.color.color ?? .gray
        return Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Circle().fill(color).frame(width: 8, height: 8)
                    Text(r.taskTitle).font(.callout.weight(.semibold))
                    if let d = DateKey.date(r.occurrenceKey), !d.isSameDay(r.createdAt) {
                        Text("for \(d.formatted(.dateTime.month(.abbreviated).day()))").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("\(r.wordCount) words · \(timeString(r.createdAt))").font(.caption).foregroundStyle(.secondary)
                }
                Text(r.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .contextMenu {
            Button("Copy text") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(r.text, forType: .string)
            }
            Button("Delete…", role: .destructive) { toDelete = r }
        }
    }

    private func export() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = "Cadence Reflections \(DateKey.string(Date())).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        var out = "# Cadence Reflections\n\n"
        let groups = Dictionary(grouping: store.reflections) { $0.createdAt.startOfDay }.sorted { $0.key > $1.key }
        for (day, items) in groups {
            out += "## \(day.formatted(.dateTime.weekday(.wide).month(.wide).day().year()))\n\n"
            for r in items.sorted(by: { $0.createdAt > $1.createdAt }) {
                out += "### \(r.taskTitle) — \(timeString(r.createdAt))\n\n\(r.text)\n\n"
            }
        }
        try? out.write(to: url, atomically: true, encoding: .utf8)
    }
}
