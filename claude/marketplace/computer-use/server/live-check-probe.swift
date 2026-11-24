// live-check-probe: separate-process macOS helper for live-check.js.
// Posts UNMARKED CGEvents (without helper.swift's MARK = 0x44534B54), so the
// desktop-helper stop panel treats its Stop click and Esc press as user input.
//
//   permissions                  Screen Recording and Accessibility status
//   app-info <name or bundleId>  running or installed app metadata (including category)
//   scene-info                   displays, frontmost app, dock level and on-screen windows
//   find-panel <pid>             bounds of the stop panel window owned by <pid>
//   click-unmarked <x> <y>       unmarked left click at global display coordinates
//   esc-unmarked                 unmarked Esc (key code 53) press
import AppKit
import ApplicationServices
import CoreGraphics

func emit(_ value: Any) {
  let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func number(_ text: String) -> Double {
  guard let value = Double(text), value.isFinite else { fail("not a number: \(text)") }
  return value
}

func bundleInfo(_ url: URL) -> [String: Any] {
  var info: [String: Any] = ["path": url.path]
  if let bundle = Bundle(url: url) {
    if let id = bundle.bundleIdentifier { info["bundleId"] = id }
    if let category = bundle.object(forInfoDictionaryKey: "LSApplicationCategoryType") as? String { info["category"] = category }
    let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
      ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
    info["name"] = name ?? url.deletingPathExtension().lastPathComponent
  }
  return info
}

func appSummary(_ app: NSRunningApplication) -> [String: Any] {
  var info: [String: Any] = [
    "name": app.localizedName ?? "",
    "bundleId": app.bundleIdentifier ?? "",
    "pid": Int(app.processIdentifier),
  ]
  if let url = app.bundleURL { info.merge(bundleInfo(url)) { old, _ in old } }
  return info
}

func findApp(_ query: String) -> [String: Any]? {
  let lower = query.lowercased()
  if let app = NSWorkspace.shared.runningApplications.first(where: {
    $0.bundleIdentifier?.lowercased() == lower || $0.localizedName?.lowercased() == lower
  }) { return appSummary(app) }
  if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) { return bundleInfo(url) }
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "\(home)/Applications"] {
    let url = URL(fileURLWithPath: dir).appendingPathComponent(query.hasSuffix(".app") ? query : "\(query).app")
    if FileManager.default.fileExists(atPath: url.path) { return bundleInfo(url) }
  }
  return nil
}

let windowServerPath = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer")
  .resolvingSymlinksInPath().path

func isWindowServer(_ pid: pid_t) -> Bool {
  var path = [CChar](repeating: 0, count: 4096)
  return proc_pidpath(pid, &path, UInt32(path.count)) > 0 && String(cString: path) == windowServerPath
}

func rectDict(_ r: CGRect) -> [String: Any] {
  ["x": r.origin.x, "y": r.origin.y, "width": r.width, "height": r.height]
}

func activeDisplays() -> [[String: Any]] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  guard count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return ids.prefix(Int(count)).enumerated().map { index, id in
    let bounds = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    let pixelWidth = mode?.pixelWidth ?? Int(bounds.width)
    let pixelHeight = mode?.pixelHeight ?? Int(bounds.height)
    return [
      "index": index,
      "id": Int(id),
      "main": CGDisplayIsMain(id) != 0,
      "x": bounds.origin.x,
      "y": bounds.origin.y,
      "width": bounds.width,
      "height": bounds.height,
      "pixelWidth": pixelWidth,
      "pixelHeight": pixelHeight,
      "scale": Double(pixelWidth) / bounds.width,
    ]
  }
}

func sceneInfo() -> [String: Any] {
  let displays = activeDisplays()
  let mainDisplay = displays.first(where: { ($0["main"] as? Bool) == true }) ?? displays.first
  var windows: [[String: Any]] = []
  for window in CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] {
    guard let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict) else { continue }
    let pid = window[kCGWindowOwnerPID as String] as? pid_t
    windows.append([
      "owner": window[kCGWindowOwnerName as String] as? String ?? "",
      "name": window[kCGWindowName as String] as? String ?? "",
      "layer": window[kCGWindowLayer as String] as? Int ?? 0,
      "alpha": window[kCGWindowAlpha as String] as? Double ?? 1,
      "bounds": rectDict(bounds),
      "pid": pid.map { Int($0) } ?? NSNull(),
      "windowServer": pid.map(isWindowServer) ?? false,
      "app": pid.flatMap { NSRunningApplication(processIdentifier: $0) }.map(appSummary) ?? NSNull(),
    ])
  }
  return [
    "displays": displays,
    "mainDisplay": mainDisplay ?? NSNull(),
    "frontmost": NSWorkspace.shared.frontmostApplication.map(appSummary) ?? NSNull(),
    "dockLevel": Int(CGWindowLevelForKey(.dockWindow)),
    "windows": windows,
  ]
}

// Matches helper.swift's 420x44 .statusBar NSPanel, ignoring any AppKit tooltip window owned by the same pid.
func findPanel(_ targetPid: pid_t) -> [String: Any] {
  let statusLevel = Int(CGWindowLevelForKey(.statusWindow))
  var fallback: CGRect?
  for window in CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] {
    guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid == targetPid else { continue }
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
    guard alpha > 0,
          let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict),
          bounds.width >= 300, bounds.height >= 30, bounds.height <= 80 else { continue }
    let layer = window[kCGWindowLayer as String] as? Int ?? 0
    if layer == statusLevel && abs(bounds.width - 420) <= 2 && abs(bounds.height - 44) <= 2 {
      return ["found": true, "bounds": rectDict(bounds)]
    }
    if fallback == nil { fallback = bounds }
  }
  if let bounds = fallback { return ["found": true, "bounds": rectDict(bounds)] }
  return ["found": false]
}

func requireAccessibility() {
  if !AXIsProcessTrusted() { fail("Accessibility permission is required to post unmarked Stop/Esc events.") }
}

let eventSource = CGEventSource(stateID: .hidSystemState)

func postUnmarked(_ event: CGEvent?) {
  guard let event else { fail("could not create CGEvent") }
  event.setIntegerValueField(.eventSourceUserData, value: 0)
  event.post(tap: .cghidEventTap)
}

func clickUnmarked(_ point: CGPoint) {
  requireAccessibility()
  postUnmarked(CGEvent(mouseEventSource: eventSource, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
  usleep(50_000)
  for type in [CGEventType.leftMouseDown, CGEventType.leftMouseUp] {
    let event = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
    event?.setIntegerValueField(.mouseEventClickState, value: 1)
    postUnmarked(event)
    usleep(30_000)
  }
}

func escUnmarked() {
  requireAccessibility()
  for down in [true, false] {
    postUnmarked(CGEvent(keyboardEventSource: eventSource, virtualKey: 53, keyDown: down))
    usleep(30_000)
  }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("usage: live-check-probe <permissions|app-info|scene-info|find-panel|click-unmarked|esc-unmarked> ...") }
let rest = Array(args.dropFirst())
func arg(_ index: Int) -> String {
  guard index < rest.count else { fail("\(command): missing argument \(index + 1)") }
  return rest[index]
}

switch command {
case "permissions":
  emit(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
case "app-info":
  emit(findApp(arg(0)) ?? NSNull())
case "scene-info":
  emit(sceneInfo())
case "find-panel":
  guard let pid = pid_t(arg(0)) else { fail("find-panel: bad pid") }
  emit(findPanel(pid))
case "click-unmarked":
  clickUnmarked(CGPoint(x: number(arg(0)), y: number(arg(1))))
  emit(["ok": true])
case "esc-unmarked":
  escUnmarked()
  emit(["ok": true])
default:
  fail("unknown command: \(command)")
}
