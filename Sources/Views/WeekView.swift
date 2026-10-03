import SwiftUI

struct WeekView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var google: GoogleCalendar
    @State private var weekStart = Date().startOfWeek

    private let hourHeight: CGFloat = 48
    private let gutter: CGFloat = 56

    private var days: [Date] { (0..<7).map { weekStart.adding(days: $0) } }

    private var title: String {
        let end = weekStart.adding(days: 6)
        let sameMonth = Calendar.current.isDate(weekStart, equalTo: end, toGranularity: .month)
        let a = weekStart.formatted(.dateTime.month(.abbreviated).day())
        let b = sameMonth ? end.formatted(.dateTime.day()) : end.formatted(.dateTime.month(.abbreviated).day())
        return "\(a) – \(b), \(end.formatted(.dateTime.year()))"
    }

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: title, subtitle: "Double-click an empty slot to add a task there.") {
                Button { model.newEvent(on: weekStart.isSameDay(Date().startOfWeek) ? Date() : weekStart) } label: {
                    Label("New Event", systemImage: "calendar.badge.plus")
                }
                CalendarNav(onPrev: { weekStart = weekStart.adding(days: -7) },
                            onToday: { weekStart = Date().startOfWeek },
                            onNext: { weekStart = weekStart.adding(days: 7) })
            }
            GeometryReader { geo in
                let colW = max(60, (geo.size.width - gutter - 8) / 7)
                VStack(spacing: 0) {
                    dayHeader(colW)
                    allDayRow(colW)
                    Divider()
                    ScrollViewReader { proxy in
                        ScrollView(.vertical) {
                            ZStack(alignment: .topLeading) {
                                hourGrid(colW)
                                ForEach(Array(days.enumerated()), id: \.offset) { i, day in
                                    ForEach(placed(day)) { p in
                                        TimedBlock(item: p.item, height: max(20, p.height(hourHeight)))
                                            .frame(width: colW / CGFloat(p.lanes) - 3,
                                                   height: max(20, p.height(hourHeight)))
                                            .offset(x: gutter + CGFloat(i) * colW + CGFloat(p.lane) * colW / CGFloat(p.lanes) + 1.5,
                                                    y: p.y(hourHeight))
                                    }
                                }
                                nowLine(colW)
                            }
                            .frame(height: hourHeight * 24, alignment: .topLeading)
                        }
                        .onAppear { proxy.scrollTo(7, anchor: .top) }
                    }
                }
            }
        }
        .onAppear { google.ensure(from: weekStart, to: weekStart.adding(days: 7)) }
        .onChange(of: weekStart) { _, new in google.ensure(from: new, to: new.adding(days: 7)) }
    }

    // MARK: Pieces

    private func dayHeader(_ colW: CGFloat) -> some View {
        HStack(spacing: 0) {
            Spacer().frame(width: gutter, height: 1)
            ForEach(days, id: \.self) { day in
                let isToday = day.isToday
                VStack(spacing: 2) {
                    Text(day.formatted(.dateTime.weekday(.abbreviated)).uppercased())
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    Text(day.formatted(.dateTime.day()))
                        .font(.title3.weight(isToday ? .bold : .regular))
                        .foregroundStyle(isToday ? .white : .primary)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(isToday ? Color.accentColor : .clear))
                    let open = store.checklist(on: day).filter { !$0.isResolved }.count
                    Text(open > 0 ? "\(open) open" : " ")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
                .frame(width: colW)
            }
        }
        .padding(.bottom, 4)
    }

    private func allDayRow(_ colW: CGFloat) -> some View {
        let columns: [[CalendarItem]] = days.map { day in
            store.occurrences(on: day).filter { $0.start == nil }.map(CalendarItem.task)
                + google.events(on: day).filter(\.isAllDay).map(CalendarItem.google)
        }
        let rows = min(4, columns.map(\.count).max() ?? 0)
        return HStack(alignment: .top, spacing: 0) {
            Text("any\ntime").font(.system(size: 9)).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                .frame(width: gutter - 8, alignment: .trailing).padding(.trailing, 8)
            ForEach(Array(columns.enumerated()), id: \.offset) { _, items in
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(items.prefix(rows == 4 && items.count > 4 ? 3 : 4)) { ItemChip(item: $0) }
                    if items.count > 4 {
                        Text("+\(items.count - 3) more").font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                .frame(width: colW - 4, alignment: .topLeading)
                .padding(.horizontal, 2)
            }
        }
        .frame(minHeight: rows == 0 ? 22 : CGFloat(rows) * 19 + 6, alignment: .top)
        .padding(.vertical, 3)
    }

    private func hourGrid(_ colW: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { h in
                    HStack(alignment: .top, spacing: 0) {
                        Text(h == 0 ? "" : timeString(minutes: h * 60))
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .frame(width: gutter - 8, alignment: .trailing)
                            .offset(y: -6)
                            .padding(.trailing, 8)
                        VStack(spacing: 0) {
                            Divider()
                            Spacer()
                        }
                    }
                    .frame(height: hourHeight)
                    .id(h)
                }
            }
            HStack(spacing: 0) {
                Color.clear.frame(width: gutter)
                ForEach(days, id: \.self) { day in
                    Rectangle()
                        .fill(day.isToday ? Color.accentColor.opacity(0.04) : Color.clear)
                        .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.06)).frame(width: 1) }
                        .frame(width: colW)
                        .contentShape(Rectangle())
                        .gesture(SpatialTapGesture(count: 2).onEnded { v in
                            let minutes = Int(v.location.y / hourHeight * 60) / 30 * 30
                            model.newTask(on: day, minutes: min(minutes, 23 * 60 + 30))
                        })
                }
            }
        }
    }

    @ViewBuilder private func nowLine(_ colW: CGFloat) -> some View {
        if let i = days.firstIndex(where: \.isToday) {
            let y = CGFloat(Date().minutesSinceMidnight) / 60 * hourHeight
            HStack(spacing: 0) {
                Circle().fill(.red).frame(width: 8, height: 8)
                Rectangle().fill(.red).frame(width: colW - 8, height: 1.5)
            }
            .offset(x: gutter + CGFloat(i) * colW - 4, y: y - 4)
            .allowsHitTesting(false)
        }
    }

    // MARK: Layout of overlapping items

    struct Placed: Identifiable {
        let item: CalendarItem
        let start: Date
        let end: Date
        let day: Date
        var lane = 0
        var lanes = 1
        var id: String { item.id }

        func y(_ hh: CGFloat) -> CGFloat {
            CGFloat(max(0, start.timeIntervalSince(day.startOfDay)) / 3600) * hh
        }
        func height(_ hh: CGFloat) -> CGFloat {
            let s = max(start, day.startOfDay)
            let e = min(end, day.startOfDay.adding(days: 1))
            return CGFloat(e.timeIntervalSince(s) / 3600) * hh
        }
    }

    private func placed(_ day: Date) -> [Placed] {
        var items: [Placed] = []
        for occ in store.occurrences(on: day) {
            if let s = occ.start, let e = occ.end { items.append(Placed(item: .task(occ), start: s, end: e, day: day)) }
        }
        for ev in google.events(on: day) where !ev.isAllDay {
            items.append(Placed(item: .google(ev), start: ev.start, end: ev.end, day: day))
        }
        items.sort { ($0.start, $1.end) < ($1.start, $0.end) }

        // Greedy lane assignment within clusters of overlapping items.
        var result: [Placed] = []
        var cluster: [Placed] = []
        var laneEnds: [Date] = []
        var clusterEnd = Date.distantPast
        func flush() {
            let n = max(1, laneEnds.count)
            result += cluster.map { var p = $0; p.lanes = n; return p }
            cluster = []; laneEnds = []
        }
        for var p in items {
            if p.start >= clusterEnd { flush() }
            if let free = laneEnds.firstIndex(where: { $0 <= p.start }) {
                p.lane = free; laneEnds[free] = p.end
            } else {
                p.lane = laneEnds.count; laneEnds.append(p.end)
            }
            clusterEnd = max(clusterEnd, p.end)
            cluster.append(p)
        }
        flush()
        return result
    }
}

struct TimedBlock: View {
    @EnvironmentObject private var model: AppModel
    let item: CalendarItem
    let height: CGFloat
    @State private var showing = false

    /// The clock time at a vertical position inside the block.
    private func moment(atY y: CGFloat) -> Date? {
        guard let s = item.start, let e = item.end else { return nil }
        let f = min(max(y / max(height, 1), 0), 1)
        return s.addingTimeInterval(e.timeIntervalSince(s) * f)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                if item.isCalendarEvent {
                    Image(systemName: "calendar").font(.system(size: 8, weight: .bold))
                } else if item.isDone {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 9))
                } else if item.isMissed {
                    Image(systemName: "xmark.square.fill").font(.system(size: 9)).foregroundStyle(.red)
                }
                Text(item.title).font(.system(size: 11, weight: .semibold)).lineLimit(2)
                    .strikethrough(item.isDone || item.isMissed, color: item.isMissed ? .red : nil)
            }
            if let s = item.start {
                Text(timeString(s)).font(.system(size: 10)).opacity(0.75)
            }
        }
        .foregroundStyle(item.isDone || item.isMissed ? Color.secondary : Color.primary)
        .padding(.leading, 6)
        .padding(.trailing, 3)
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(item.color.opacity(item.isDone ? 0.10 : (item.isCalendarEvent ? 0.14 : 0.24)))
        .background { if !item.isBusy { OpenStripes(color: item.color) } }
        .overlay(alignment: .leading) {
            // Open items (just for info) get a dotted edge and stripes, so closed ones read as "taken".
            if item.isBusy { Rectangle().fill(item.color).frame(width: 3) }
            else { Rectangle().stroke(item.color, style: StrokeStyle(lineWidth: 3, dash: [2, 2])).frame(width: 1.5) }
        }
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        .contentShape(Rectangle())
        // Double-click inside a block adds a task at that exact time; single click shows details.
        .gesture(
            SpatialTapGesture(count: 2)
                .onEnded { v in if let m = moment(atY: v.location.y) { model.newTask(at: m) } }
                .exclusively(before: TapGesture().onEnded { showing = true })
        )
        .help("\(item.isBusy ? "Closed" : "Open (just for info)") · click for details · double-click to add a task at this time")
        .contextMenu { AddDuringMenu(item: item) }
        .popover(isPresented: $showing, arrowEdge: .trailing) { ItemDetail(item: item) { showing = false } }
    }
}
