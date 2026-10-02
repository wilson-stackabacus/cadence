import SwiftUI

/// Sync status with motion: arrows spin while syncing, a check appears when it finishes,
/// and the label ages ("Synced just now" → "Synced 3 min ago"). Click to sync now.
struct SyncIndicator: View {
    @EnvironmentObject private var sync: SyncService
    var prominent = false

    @EnvironmentObject private var model: AppModel

    var body: some View {
        if !sync.isSignedIn {
            // Never look like it's syncing when it isn't.
            Button { model.screen = .settings } label: {
                HStack(spacing: 6) {
                    Image(systemName: "icloud.slash").frame(width: 14, height: 14)
                    Text("Not syncing · Sign in").lineLimit(1)
                }
                .font(prominent ? .callout : .caption)
                .foregroundStyle(.orange)
                .padding(.horizontal, prominent ? 10 : 6)
                .padding(.vertical, prominent ? 5 : 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(SyncButtonStyle(prominent: prominent))
            .help("This Mac isn't connected to your Cadence account. Click to sign in.")
        } else {
            Button { sync.sync(manual: true) } label: {
                HStack(spacing: 6) {
                    ZStack {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .rotationEffect(.degrees(sync.showSpinner ? 360 : 0))
                            .animation(sync.showSpinner ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default,
                                       value: sync.showSpinner)
                            .opacity(sync.justSynced ? 0 : 1)
                            .scaleEffect(sync.justSynced ? 0.5 : 1)
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .opacity(sync.justSynced ? 1 : 0)
                            .scaleEffect(sync.justSynced ? 1 : 0.5)
                    }
                    .frame(width: 14, height: 14)
                    .animation(.spring(duration: 0.35), value: sync.justSynced)
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text(label).lineLimit(1)
                    }
                }
                .font(prominent ? .callout : .caption)
                .foregroundStyle(color)
                .padding(.horizontal, prominent ? 10 : 6)
                .padding(.vertical, prominent ? 5 : 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(SyncButtonStyle(prominent: prominent))
            .help(isError ? "Click to retry" : "Sync now")
        }
    }

    private var isError: Bool { if case .error = sync.status { return true }; return false }

    private var label: String {
        if sync.showSpinner { return "Syncing…" }
        if case .error(let m) = sync.status { return m }
        guard let last = sync.lastSynced else { return "Waiting to sync" }
        let s = Date().timeIntervalSince(last)
        if s < 45 { return "Synced just now" }
        if s < 3600 { return "Synced \(Int((s / 60).rounded())) min ago" }
        return "Synced at \(timeString(last))"
    }

    private var color: Color {
        if isError { return .red }
        if sync.justSynced { return .green }
        return sync.showSpinner ? .primary : .secondary
    }
}

private struct SyncButtonStyle: ButtonStyle {
    let prominent: Bool
    @State private var hovering = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(configuration.isPressed ? 0.12 : hovering || prominent ? 0.06 : 0)))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .onHover { hovering = $0 }
    }
}
