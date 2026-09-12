// Adapter turning a RiskGate Durable Object stub into the RiskGateClient port.
// Thin by design — the stub's RPC methods already match; this keeps the port
// dependency explicit and the types honest.

import type { RiskGate } from '@trading/risk/do';
import type { RiskGateClient } from './ports.js';

export function riskGateClient(stub: DurableObjectStub<RiskGate>): RiskGateClient {
  return {
    getState: () => stub.getState(),
    ensureDay: (today, equity) => stub.ensureDay(today, equity),
    evaluateAndReserve: (args) => stub.evaluateAndReserve(args),
    recordEquityAndMaybeHalt: (config, equity) => stub.recordEquityAndMaybeHalt(config, equity),
    halt: (reason) => stub.halt(reason),
  };
}
