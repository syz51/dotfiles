// live-check-probe: separate-process macOS helper for live-check.js.
// Posts UNMARKED CGEvents (without helper.swift's MARK = 0x44534B54), so the
// desktop-helper stop panel treats its Stop click and Esc press as user input.
//
//   permissions                  Screen Recording and Accessibility status
//   scene-info                   main display, frontmost app, dock level and on-screen windows
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

func appSummary(_ app: NSRunningApplication) -> [String: Any] {
  [
    "name": app.localizedName ?? "",
    "bundleId": app.bundleIdentifier ?? "",
    "pid": Int(app.processIdentifier),
  ]
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

func mainDisplayInfo() -> [String: Any]? {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  guard count > 0 else { return nil }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let active = Array(ids.prefix(Int(count)))
  guard let id = active.first(where: { CGDisplayIsMain($0) != 0 }) ?? active.first else { return nil }
  let bounds = CGDisplayBounds(id)
  let mode = CGDisplayCopyDisplayMode(id)
  let pixelWidth = mode?.pixelWidth ?? Int(bounds.width)
  let pixelHeight = mode?.pixelHeight ?? Int(bounds.height)
  return [
    "id": Int(id),
    "x": bounds.origin.x,
    "y": bounds.origin.y,
    "width": bounds.width,
    "height": bounds.height,
    "pixelWidth": pixelWidth,
    "pixelHeight": pixelHeight,
    "scale": Double(pixelWidth) / bounds.width,
  ]
}

func sceneInfo() -> [String: Any] {
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
    "mainDisplay": mainDisplayInfo() ?? NSNull(),
    "frontmost": NSWorkspace.shared.frontmostApplication.map(appSummary) ?? NSNull(),
    "dockLevel": Int(CGWindowLevelForKey(.dockWindow)),
    "windows": windows,
  ]
}

func findPanel(_ targetPid: pid_t) -> [String: Any] {
  for window in CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [] {
    guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid == targetPid else { continue }
    let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
    guard alpha > 0,
          let boundsDict = window[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: boundsDict),
          bounds.width > 0, bounds.height > 0 else { continue }
    return ["found": true, "bounds": rectDict(bounds)]
  }
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
guard let command = args.first else { fail("usage: live-check-probe <permissions|scene-info|find-panel|click-unmarked|esc-unmarked> ...") }
let rest = Array(args.dropFirst())
func arg(_ index: Int) -> String {
  guard index < rest.count else { fail("\(command): missing argument \(index + 1)") }
  return rest[index]
}

switch command {
case "permissions":
  emit(["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
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
