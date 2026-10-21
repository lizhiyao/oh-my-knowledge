import type { AddressInfo } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import type { ReportServerAddresses } from './contracts.js';

/** 绑定结果决定地址与端口；网卡只补充通配监听时的同 family 候选。 */
export function projectServerAddresses(
  address: AddressInfo,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): ReportServerAddresses {
  const authority = (host: string): string => `${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  const wildcard = address.address === '0.0.0.0' || address.address === '::';
  const localHost = wildcard ? address.family === 'IPv6' ? '::1' : '127.0.0.1' : address.address;
  const networkUrls = wildcard ? Object.values(interfaces).flatMap(entries => entries ?? [])
    .filter(entry => !entry.internal && entry.family === address.family
      // Scoped IPv6 needs an interface zone; it is not a portable browser URL.
      && (entry.family !== 'IPv6' || (entry.scopeid === 0 && !/^fe[89ab]/i.test(entry.address))))
    .map(entry => `http://${authority(entry.address)}`) : [];
  return {
    bindAddress: authority(address.address),
    url: `http://${authority(localHost)}`,
    networkUrls: [...new Set(networkUrls)].sort(),
  };
}
