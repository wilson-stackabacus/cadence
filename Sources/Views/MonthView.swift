import SwiftUI

struct MonthView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    @State private var month = Date().startOfMonth
    @State private var selected = Date().startOfDay

    private var gridDays: [Date] {
        let first = month.startOfWeek
        return (0..<42).map { first.adding(days: $0) }
    }

    private var weekdaySymbols: [String] {
        let cal = Calendar.current
        let s = cal.shortWeekdaySymbols
        let k = cal.firstWeekday - 1
        return Array(s[k...] + s[..<k])
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                ScreenHeader(title: month.formatted(.dateTime.month(.wide).year()),
                             subtitle: "Click a day to see it, double-click to add a task.") {
                    CalendarNav(onPrev: { month = month.adding(months: -1) },
                                onToday: { month = Date().startOfMonth; selected = Date().startOfDay },
                                onNext: { month = month.adding(months: 1) })
                }
                HStack(spacing: 0) {
                    ForEach(weekdaySymbols, id: \.self) { s in
                        Text(s.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
                GeometryReader { geo in
                    let cellH = (geo.size.height - 2) / 6
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 0) {
                        ForEach(gridDays, id: \.self) { day in
                            MonthCell(day: day,
                                      inMonth: Calendar.current.isDate(day, equalTo: month, toGranularity: .month),
                                      isSelected: day == selected,
                                      maxItems: max(1, Int((cellH - 30) / 17)))
                                .frame(height: cellH)
                                .contentShape(Rectangle())
                                .onTapGesture(count: 2) { model.newTask(on: day) }
                                .onTapGesture { selected = day }
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.08)))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
            Divider()
            DayPanel(day: selected)
                .frame(width: 300)
        }
        .onAppear { google.ensure(from: gridDays[0], to: gridDays[41].adding(days: 1)) }
        .onChange(of: month) { _, _ in google.ensure(from: gridDays[0], to: gridDays[41].adding(days: 1)) }
    }
}

private struct MonthCell: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    let day: Date
    let inMonth: Bool
    let isSelected: Bool
    let maxItems: Int

    var body: some View {
        let items = store.occurrences(on: day).map(CalendarItem.task)
            + google.events(on: day).map(CalendarItem.google)
        let shown = items.count > maxItems ? max(0, maxItems - 1) : maxItems
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(day.formatted(.dateTime.day()))
                    .font(.callout.weight(day.isToday ? .bold : .regular))
                    .foregroundStyle(day.isToday ? .white : (inMonth ? .primary : .secondary))
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(day.isToday ? Color.accentColor : .clear))
                Spacer()
                let tasks = store.occurrences(on: day)
                if !tasks.isEmpty && tasks.allSatisfy(\.isDone) {
                    Image(systemName: "checkmark.seal.fill").font(.caption).foregroundStyle(.green)
                        .help("Everything done")
                }
            }
            ForEach(items.prefix(shown)) { item in
                MiniChip(item: item)
            }
            if items.count > shown {
                Text("+\(items.count - shown) more").font(.system(size: 10)).foregroundStyle(.secondary).padding(.leading, 4)
            }
            Spacer(minLength: 0)
        }
        .padding(4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(isSelected ? Color.accentColor.opacity(0.10) : (inMonth ? Color.clear : Color.primary.opacity(0.025)))
        .overlay(Rectangle().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
        .opacity(inMonth ? 1 : 0.65)
    }
}

/// Non-interactive chip for month cells (the whole cell is the click target).
private struct MiniChip: View {
    let item: CalendarItem
    var body: some View {
        HStack(spacing: 3) {
            if item.isGoogle {
                Image(systemName: "calendar").font(.system(size: 7, weight: .bold)).foregroundStyle(item.color)
            } else {
                Circle().fill(item.isDone ? Color.clear : item.color).frame(width: 6, height: 6)
                    .overlay(Circle().strokeBorder(item.color, lineWidth: 1))
            }
            Text(item.title).font(.system(size: 10.5)).lineLimit(1)
                .strikethrough(item.isDone)
                .foregroundStyle(item.isDone ? .secondary : .primary)
        }
        .padding(.horizontal, 3)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 3).fill(item.color.opacity(0.12)))
    }
}

/// Side panel listing everything on one day.
struct DayPanel: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    let day: Date

    var body: some View {
        let tasks = store.occurrences(on: day)
        let events = google.events(on: day)
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(day.formatted(.dateTime.weekday(.wide))).foregroundStyle(.secondary)
                Text(day.formatted(.dateTime.month(.wide).day())).font(.title2.bold())
            }
            Button { model.newTask(on: day) } label: { Label("Add task on this day", systemImage: "plus") }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if tasks.isEmpty && events.isEmpty {
                        Text("Nothing planned.").foregroundStyle(.secondary)
                    }
                    if !tasks.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            SectionTitle(text: "Checklist", count: tasks.count)
                            ForEach(tasks) { ChecklistRow(occ: $0, compact: true) }
                        }
                    }
                    if !events.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            SectionTitle(text: "Google Calendar", count: events.count)
                            ForEach(events) { ItemChip(item: .google($0)) }
                        }
                    }
                }
            }
        }
        .padding(18)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }
}
