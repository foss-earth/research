// Prints the macOS thermal and power signals that need no privileges, as one JSON line on stdout.
// lib/telemetry.mjs compiles it on demand (ensureThermalHelper) into <work>/bin/thermal and runs it
// before and after every timed block; acceptance rule I counts a block as disturbed when the thermal
// state is above nominal at either end.
//
//   swiftc -O -module-cache-path <work>/cache/swift-modules -o <work>/bin/thermal lib/thermal.swift
//   <work>/bin/thermal
//   {"activeProcessorCount":10,"lowPowerMode":false,"processorCount":10,"schema":1,"thermalPressureLevel":0,...}
//
// thermalState is ProcessInfo.ThermalState: 0 nominal, 1 fair, 2 serious, 3 critical.
// thermalPressureLevel is the state of the com.apple.system.thermalpressurelevel notification
// (OSThermalNotification.h, macOS values): 0 nominal, 1 moderate, 2 heavy, 3 trapping, 4 sleeping;
// null when the notification cannot be read. Only these numbers are printed: nothing that names the
// machine, its user or other processes.
import Foundation
import notify

let stateNames = ["nominal", "fair", "serious", "critical"]
let pressureNames = ["nominal", "moderate", "heavy", "trapping", "sleeping"]
let info = ProcessInfo.processInfo
let state = info.thermalState.rawValue

var pressureLevel: Any = NSNull()
var pressureName = "unavailable"
var token: Int32 = 0
if notify_register_check("com.apple.system.thermalpressurelevel", &token) == UInt32(NOTIFY_STATUS_OK) {
  var level: UInt64 = 0
  if notify_get_state(token, &level) == UInt32(NOTIFY_STATUS_OK) {
    pressureLevel = level
    pressureName = level < UInt64(pressureNames.count) ? pressureNames[Int(level)] : "unknown"
  }
  notify_cancel(token)
}

let record: [String: Any] = [
  "schema": 1,
  "thermalState": state,
  "thermalStateName": state < stateNames.count ? stateNames[state] : "unknown",
  "thermalPressureLevel": pressureLevel,
  "thermalPressureName": pressureName,
  "lowPowerMode": info.isLowPowerModeEnabled,
  "processorCount": info.processorCount,
  "activeProcessorCount": info.activeProcessorCount,
]
let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
