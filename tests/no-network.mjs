import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';
export const networkAttempts=[];
function deny() { networkAttempts.push(new Error().stack); throw new Error('Offline regression forbids network access'); }
process.once('beforeExit',()=>{if(networkAttempts.length)throw new Error('Offline regression attempted network access');});
globalThis.fetch=deny;
globalThis.WebSocket=class { constructor(){deny();} };
http.request=http.get=https.request=https.get=deny;
net.connect=net.createConnection=net.Socket.prototype.connect=deny;
tls.connect=deny;
dgram.createSocket=deny;
for(const key of Object.keys(dns)) if(typeof dns[key]==='function' && /^(lookup|resolve|reverse)/.test(key)) dns[key]=deny;
for(const key of Object.keys(dns.promises)) if(typeof dns.promises[key]==='function') dns.promises[key]=deny;
syncBuiltinESMExports();
