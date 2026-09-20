/* Action-driven in-browser transport. It forwards real opaque frames between
 * isolated endpoints. No timers, protocol shortcuts, or synthesized replies.
 * Enrollment deliberately stops at the application approval boundary.
 */
export async function exchange(server, device, now, log = () => {}) {
  if (!device) {
    log('Device is stopped. Pending changes will synchronize when it starts.');
    return;
  }
  let delivered = 0;
  async function deliver(sender, receiver, label) {
    const frame = await sender.outbound();
    if (!frame) return false;
    const before = receiver.state();
    try { await receiver.receive(frame, now); }
    catch (error) {
      log(`${label}: rejected (${error.message}).`);
      throw error;
    }
    delivered++;
    log(`${label} (${frame.length} bytes).`);
    const after = receiver.state();
    if (!before.registered && after.registered) log('Device enrollment confirmed.');
    if (receiver === device && before.credits_issued !== after.credits_issued)
      log(`Device credits issued: ${after.credits_issued}.`);
    if (receiver === server && before.credits_consumed !== after.credits_consumed)
      log(`Server last reported consumed: ${after.credits_consumed}.`);
    return true;
  }

  const state = server.state();
  if (!state.registered) {
    if (!state.enrollment_expires || state.enrollment_expires === '0') {
      log('Waiting for the server to authorize enrollment.');
      return;
    }
    if (now >= BigInt(state.enrollment_expires))
      throw new Error('Enrollment session expired. Authorize a new session.');
    if (/^0+$/.test(state.candidate_key)) {
      await deliver(server, device, 'Server → device: signed enrollment challenge');
      await deliver(device, server, 'Device → server: encrypted enrollment response');
    }
    log('Enrollment response received. Awaiting server approval.');
    return;
  }

  if (!device.state().registered) {
    // Re-sending the device claim also recovers confirmation after a server
    // reload, because the core intentionally does not persist its receipt flag.
    await deliver(device, server, 'Device → server: encrypted enrollment response');
    await deliver(server, device, 'Server → device: enrollment confirmation');
    if (!device.state().registered) throw new Error('Device enrollment is not confirmed.');
  }

  // A request, snapshot, and receipt normally settle in two passes. A hard bound
  // protects the UI from perpetual retransmission if either endpoint misbehaves.
  for (let pass = 0; pass < 8; pass++) {
    const fromServer = await deliver(server, device, 'Server → device: encrypted message');
    const fromDevice = await deliver(device, server, 'Device → server: encrypted message');
    if (!fromServer && !fromDevice) {
      log(delivered ? 'Exchange complete.' : 'Connected. No pending messages.');
      return;
    }
  }
  throw new Error('Exchange did not settle. Synchronization paused; retry with sync.');
}
