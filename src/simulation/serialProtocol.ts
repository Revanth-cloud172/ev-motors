/**
 * EV Motor Digital Twin - Web Serial API & Hardware Communication Protocol
 * Target Hardware: STM32 NUCLEO-F446RE via ST-LINK Virtual COM Port (USART2 PA2/PA3)
 * Data format: Newline-terminated JSON
 */

import {
  HardwarePacketStats,
  MotorTelemetry,
  RawHardwarePacket,
  SerialConnectionStatus,
} from './types';
import { calculateHealthIndex, MOTOR_SPECS } from './motorPhysics';

export const SUPPORTED_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export interface SerialManagerCallbacks {
  onTelemetry: (telemetry: MotorTelemetry) => void;
  onRawLine: (raw: string, isError: boolean) => void;
  onStatusChange: (status: SerialConnectionStatus, errorMsg?: string) => void;
  onStatsUpdate: (stats: HardwarePacketStats) => void;
}

export class Stm32SerialManager {
  private port: any = null;
  private reader: any = null;
  private keepReading = false;
  private lineBuffer = '';
  private textDecoder = new TextDecoder();
  private callbacks: SerialManagerCallbacks;
  private startTime = 0;
  private lastPacketTimestamp = 0;
  private staleTimer: any = null;

  public stats: HardwarePacketStats = {
    validCount: 0,
    invalidCount: 0,
    lastTimestamp: null,
    bytesReceived: 0,
    isStale: false,
  };

  constructor(callbacks: SerialManagerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Check if the browser supports the Web Serial API
   */
  public static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  /**
   * Connect to STM32 NUCLEO-F446RE board via Web Serial API
   * @param baudRate Defaults to 115200
   */
  public async connect(baudRate = 115200): Promise<void> {
    if (!Stm32SerialManager.isSupported()) {
      this.callbacks.onStatusChange(
        'UNSUPPORTED',
        'Web Serial API is not supported in this browser. Please use desktop Google Chrome, Microsoft Edge, or Opera.'
      );
      return;
    }

    try {
      this.callbacks.onStatusChange('CONNECTING');

      // Request port from user
      // ST-LINK USB VID: 0x0483 (STMicroelectronics)
      const serial = (navigator as any).serial;
      this.port = await serial.requestPort({
        filters: [{ usbVendorId: 0x0483 }], // Auto-highlight STMicroelectronics boards
      }).catch(async (err: any) => {
        // Fallback without filter in case generic driver/hub is used
        if (err.name === 'NotFoundError') throw err;
        return await serial.requestPort();
      });

      if (!this.port) {
        throw new Error('No serial port selected.');
      }

      await this.port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        bufferSize: 4096,
      });

      const portInfo = this.port.getInfo ? this.port.getInfo() : {};
      this.stats.portInfo = `USB VID:${portInfo.usbVendorId?.toString(16) || '0483'} PID:${portInfo.usbProductId?.toString(16) || '374b'} @ ${baudRate} baud`;
      this.startTime = Date.now();
      this.keepReading = true;
      this.stats.isStale = false;

      this.callbacks.onStatusChange('CONNECTED');
      this.callbacks.onRawLine(`[SYSTEM] Connected to STM32 VCP @ ${baudRate} baud. Awaiting JSON stream...`, false);

      this.startStaleWatchdog();
      this.readSerialLoop();
    } catch (error: any) {
      console.warn('Web Serial connection failed:', error);
      const msg = error.name === 'NotFoundError' ? 'Serial port selection cancelled.' : (error.message || 'Failed to open serial port.');
      this.callbacks.onStatusChange('ERROR', msg);
      this.callbacks.onRawLine(`[ERROR] ${msg}`, true);
    }
  }

  /**
   * Gracefully disconnect from serial port
   */
  public async disconnect(): Promise<void> {
    this.keepReading = false;
    this.stopStaleWatchdog();

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (err) {
        console.warn('Reader cancel error:', err);
      }
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch (err) {
        console.warn('Port close error:', err);
      }
      this.port = null;
    }

    this.callbacks.onStatusChange('DISCONNECTED');
    this.callbacks.onRawLine('[SYSTEM] Disconnected from serial hardware.', false);
  }

  /**
   * Continuous stream reader loop
   */
  private async readSerialLoop(): Promise<void> {
    while (this.port && this.port.readable && this.keepReading) {
      try {
        this.reader = this.port.readable.getReader();
        while (this.keepReading) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) {
            this.stats.bytesReceived += value.length;
            const chunkText = this.textDecoder.decode(value, { stream: true });
            this.processIncomingChunk(chunkText);
          }
        }
      } catch (error: any) {
        if (this.keepReading) {
          console.warn('Serial read error:', error);
          this.callbacks.onStatusChange('ERROR', error.message || 'Serial read error occurred.');
          this.callbacks.onRawLine(`[READ ERROR] ${error.message}`, true);
        }
      } finally {
        if (this.reader) {
          try {
            this.reader.releaseLock();
          } catch {}
          this.reader = null;
        }
      }
    }
  }

  /**
   * Parse incoming serial stream line by line
   */
  private processIncomingChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split(/\r?\n/);
    // Keep whatever is after the last newline in buffer
    this.lineBuffer = lines.pop() || '';

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      this.parseAndDispatchLine(trimmed);
    }
  }

  /**
   * Validate JSON and convert to standard MotorTelemetry object
   */
  public parseAndDispatchLine(line: string): boolean {
    try {
      const parsed = JSON.parse(line) as RawHardwarePacket;
      const validated = validateHardwarePacket(parsed);

      if (!validated.isValid || !validated.packet) {
        this.stats.invalidCount++;
        this.callbacks.onRawLine(`[INVALID JSON] ${line} (${validated.reason})`, true);
        this.callbacks.onStatsUpdate({ ...this.stats });
        return false;
      }

      this.stats.validCount++;
      const now = Date.now();
      this.stats.lastTimestamp = now;
      this.lastPacketTimestamp = now;
      if (this.stats.isStale) {
        this.stats.isStale = false;
        this.callbacks.onRawLine('[SYSTEM] Hardware telemetry stream recovered.', false);
      }

      // Transform into full MotorTelemetry
      const telemetry = createTelemetryFromHardware(
        validated.packet,
        now,
        (now - (this.startTime || now)) / 1000
      );

      this.callbacks.onTelemetry(telemetry);
      this.callbacks.onRawLine(line, false);
      this.callbacks.onStatsUpdate({ ...this.stats });
      return true;
    } catch (err: any) {
      this.stats.invalidCount++;
      this.callbacks.onRawLine(`[MALFORMED] ${line}`, true);
      this.callbacks.onStatsUpdate({ ...this.stats });
      return false;
    }
  }

  /**
   * Watchdog to flag stale data if messages stop arriving (>2.5s)
   */
  private startStaleWatchdog(): void {
    this.stopStaleWatchdog();
    this.staleTimer = setInterval(() => {
      if (this.lastPacketTimestamp > 0 && Date.now() - this.lastPacketTimestamp > 2500) {
        if (!this.stats.isStale) {
          this.stats.isStale = true;
          this.callbacks.onRawLine('[WARNING] Hardware telemetry timeout: No serial packets received for >2.5s', true);
          this.callbacks.onStatsUpdate({ ...this.stats });
        }
      }
    }, 1000);
  }

  private stopStaleWatchdog(): void {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }
}

/**
 * Validates incoming hardware packet field types, names, and acceptable bounds
 */
export function validateHardwarePacket(pkt: any): {
  isValid: boolean;
  packet?: RawHardwarePacket;
  reason?: string;
} {
  if (typeof pkt !== 'object' || pkt === null) {
    return { isValid: false, reason: 'Packet is not a valid JSON object' };
  }

  // Check required numeric fields
  const fields = ['rpm', 'current_A', 'voltage_V', 'temperature_C', 'vibration_mm_s'];
  for (const f of fields) {
    if (pkt[f] === undefined || pkt[f] === null || typeof pkt[f] !== 'number' || isNaN(pkt[f])) {
      return { isValid: false, reason: `Missing or invalid numeric field '${f}'` };
    }
  }

  // Validate realistic engineering bounds
  if (pkt.rpm < 0 || pkt.rpm > 18000) {
    return { isValid: false, reason: `RPM value ${pkt.rpm} outside plausible limits (0-18000)` };
  }
  if (pkt.current_A < -500 || pkt.current_A > 600) {
    return { isValid: false, reason: `Current ${pkt.current_A}A outside plausible limits` };
  }
  if (pkt.voltage_V < 0 || pkt.voltage_V > 1200) {
    return { isValid: false, reason: `Voltage ${pkt.voltage_V}V outside plausible limits` };
  }
  if (pkt.temperature_C < -40 || pkt.temperature_C > 250) {
    return { isValid: false, reason: `Temperature ${pkt.temperature_C}°C outside plausible limits` };
  }
  if (pkt.vibration_mm_s < 0 || pkt.vibration_mm_s > 60) {
    return { isValid: false, reason: `Vibration ${pkt.vibration_mm_s} mm/s outside plausible limits` };
  }

  return { isValid: true, packet: pkt };
}

/**
 * Converts a validated RawHardwarePacket into a full MotorTelemetry structure
 * Safely computes missing derived values (torque, power, health) and tags them.
 */
export function createTelemetryFromHardware(
  pkt: RawHardwarePacket,
  timestamp: number,
  timeSec: number
): MotorTelemetry {
  const speedRpm = pkt.rpm!;
  const phaseCurrentA = pkt.current_A!;
  const dcBusVoltageV = pkt.voltage_V!;
  const windingTempC = pkt.temperature_C!;
  const vibrationRms = pkt.vibration_mm_s!;
  const loadPct = typeof pkt.load_pct === 'number' ? pkt.load_pct : 50;

  let torqueNm: number;
  let isTorqueDerived = false;
  if (typeof pkt.torque_Nm === 'number' && !isNaN(pkt.torque_Nm)) {
    torqueNm = pkt.torque_Nm;
  } else {
    // Derived from phase current & motor Kt (0.88 Nm/A)
    const effectiveIq = Math.max(0, phaseCurrentA - 12.0);
    torqueNm = Number((effectiveIq * 0.88).toFixed(1));
    isTorqueDerived = true;
  }

  let powerKw: number;
  let isPowerDerived = false;
  if (typeof pkt.power_kW === 'number' && !isNaN(pkt.power_kW)) {
    powerKw = pkt.power_kW;
  } else {
    // P = Torque * Omega / 1000
    const omega = (speedRpm * 2 * Math.PI) / 60;
    powerKw = Number(((torqueNm * omega) / 1000).toFixed(2));
    isPowerDerived = true;
  }

  let healthIndex: number;
  let isHealthDerived = false;
  if (typeof pkt.health_index === 'number' && !isNaN(pkt.health_index)) {
    healthIndex = Math.max(0, Math.min(100, Math.round(pkt.health_index)));
  } else {
    healthIndex = calculateHealthIndex({
      windingTempC,
      phaseCurrentA,
      vibrationRms,
      dcBusVoltageV,
      activeFault: 'none',
    });
    isHealthDerived = true;
  }

  const thermalMarginC = Math.max(0, Number((MOTOR_SPECS.maxWindingTempC - windingTempC).toFixed(1)));
  const currentHeadroomA = Math.max(0, Number((MOTOR_SPECS.maxCurrentA - phaseCurrentA).toFixed(1)));
  const totalElectricalInputW = Math.max(0, powerKw * 1000) + (3 * Math.pow(phaseCurrentA, 2) * 0.028);
  const efficiencyPct = powerKw > 0.5 && totalElectricalInputW > 0
    ? Math.min(97.5, Math.max(40.0, Number((((powerKw * 1000) / totalElectricalInputW) * 96.5).toFixed(1))))
    : 0;

  return {
    timestamp,
    timeSec: Number(timeSec.toFixed(2)),
    speedRpm: Number(speedRpm.toFixed(1)),
    speedSetpointRpm: speedRpm,
    phaseCurrentA: Number(phaseCurrentA.toFixed(2)),
    dcBusVoltageV: Number(dcBusVoltageV.toFixed(1)),
    windingTempC: Number(windingTempC.toFixed(1)),
    trueWindingTempC: Number(windingTempC.toFixed(1)),
    torqueNm: Number(torqueNm.toFixed(1)),
    powerKw: Number(powerKw.toFixed(2)),
    vibrationRms: Number(vibrationRms.toFixed(2)),
    healthIndex,
    thermalMarginC,
    currentHeadroomA,
    efficiencyPct,
    activeFaultId: 'none',
    status: 'RUNNING',
    dataSource: 'HARDWARE',
    derivedFields: {
      torque: isTorqueDerived,
      power: isPowerDerived,
      health: isHealthDerived,
    },
  };
}
