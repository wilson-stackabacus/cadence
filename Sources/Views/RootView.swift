import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store

    private var selection: Binding<Screen?> {
        Binding(get: { model.screen }, set: { if let s = $0 { model.screen = s } })
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                Section("Plan") {
                    row(.today).badge(store.remainingToday)
                    row(.week)
                    row(.month)
                    row(.todo)
                }
                Section("Grow") {
                    row(.reflections).badge(store.reflections.count)
                }
                Section("Connect") {
                    row(.booking)
                }
                Section {
                    row(.settings)
                }
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
            .safeAreaInset(edge: .top) {
                HStack(spacing: 8) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 30, height: 30)
                    Text("Cadence").font(.title3.weight(.bold))
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 4)
            }
            .safeAreaInset(edge: .bottom) {
                Button { model.newTask() } label: {
                    Label("New Task", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut("n", modifiers: .command)
                .padding(12)
            }
        } detail: {
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color(nsColor: .windowBackgroundColor))
        }
        .sheet(item: $model.reflectionTarget) { occ in
            ReflectionForm(occurrence: occ, minWords: store.settings.minReflectionWords) { text in
                store.complete(occ, reflection: text)
                model.reflectionTarget = nil
            } onCancel: {
                model.reflectionTarget = nil
            }
        }
        .sheet(item: $model.editingTask) { task in
            TaskEditor(task: task, isNew: store.task(task.id) == nil)
        }
    }

    private func row(_ s: Screen) -> some View {
        Label(s.title, systemImage: s.symbol).tag(s)
    }

    @ViewBuilder private var detail: some View {
        switch model.screen {
        case .today: TodayView()
        case .week: WeekView()
        case .month: MonthView()
        case .todo: TodoView()
        case .reflections: ReflectionsView()
        case .booking: BookingView()
        case .settings: SettingsView()
        }
    }
}
