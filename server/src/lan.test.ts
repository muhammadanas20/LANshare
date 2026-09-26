/**
 * LAN address discovery for offline mode. The host prints these addresses and hands them to
 * its own UI as join URLs, so the filtering rules matter: an internal or loopback address
 * would produce a URL that no other device can open.
 */
import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { joinUrls, lanAddresses } from './lan.js';

const iface = (entries: Array<Partial<NetworkInterfaceInfo>>) => entries as NetworkInterfaceInfo[];

describe('lanAddresses', () => {
  it('keeps external IPv4 addresses and drops internal/loopback and IPv6', () => {
    const addresses = lanAddresses({
      lo: iface([{ family: 'IPv4', address: '127.0.0.1', internal: true }]),
      eth0: iface([{ family: 'IPv4', address: '192.168.1.23', internal: false }]),
      wlan0: iface([{ family: 'IPv4', address: '10.0.0.7', internal: false }]),
      eth1: iface([{ family: 'IPv6', address: 'fe80::1', internal: false } as Partial<NetworkInterfaceInfo>]),
    });
    expect(addresses).toEqual(['10.0.0.7', '192.168.1.23']);
  });

  it('deduplicates the same address on multiple interfaces', () => {
    expect(
      lanAddresses({
        a: iface([{ family: 'IPv4', address: '192.168.0.5', internal: false }]),
        b: iface([{ family: 'IPv4', address: '192.168.0.5', internal: false }]),
      }),
    ).toEqual(['192.168.0.5']);
  });

  it('returns an empty list instead of throwing when there is no network', () => {
    expect(lanAddresses({ lo: iface([{ family: 'IPv4', address: '127.0.0.1', internal: true }]) })).toEqual([]);
  });
});

describe('joinUrls', () => {
  it('builds one URL per address with the right scheme', () => {
    const interfaces = {
      eth0: iface([{ family: 'IPv4', address: '192.168.1.23', internal: false }]),
      wlan0: iface([{ family: 'IPv4', address: '10.0.0.7', internal: false }]),
    };
    expect(joinUrls(8080, 'http', interfaces)).toEqual(['http://10.0.0.7:8080', 'http://192.168.1.23:8080']);
    expect(joinUrls(8443, 'https', interfaces)).toEqual(['https://10.0.0.7:8443', 'https://192.168.1.23:8443']);
  });
});
