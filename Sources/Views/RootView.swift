import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store

    private var selection: Binding<Screen?> {
        Binding(get: { model.screen }, set: { if let s = $0 { model.screen = s } })
    }

    var body: some View {
        NavigationSplitView {
            // Header and footer sit outside the List (no safeAreaInset): insets on a macOS sidebar
            // List can shift where clicks land, which made the first row under each header miss.
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(nsImage: NSApp.applicationIconImage)
                        .resizable()
                        .frame(width: 28, height: 28)
                    Text("Cadence").font(.title3.weight(.bold))
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 2)

                List(selection: selection) {
                    Section {
                        row(.home)
                    }
                    Section("Plan") {
                        row(.today, badge: store.remainingToday)
                        row(.week)
                        row(.month)
                        row(.todo)
                    }
                    Section("Grow") {
                        row(.reflections, badge: store.reflections.count)
                    }
                    Section("Connect") {
                        row(.booking)
                    }
                    Section {
                        row(.settings)
                    }
                }
                .listStyle(.sidebar)

                VStack(alignment: .leading, spacing: 6) {
                    Button { model.newTask() } label: {
                        Label("New Task", systemImage: "plus").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut("n", modifiers: .command)
                    SyncIndicator()
                }
                .padding(12)
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
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

    private func row(_ s: Screen, badge: Int = 0) -> some View {
        Label(s.title, systemImage: s.symbol)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            // Belt and braces: a click anywhere on the row switches screens even if List selection misses it.
            .simultaneousGesture(TapGesture().onEnded { model.screen = s })
            .badge(badge)
            .tag(s)
    }

    @ViewBuilder private var detail: some View {
        switch model.screen {
        case .home: HomeView()
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
