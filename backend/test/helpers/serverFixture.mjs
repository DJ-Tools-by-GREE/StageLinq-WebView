import http from 'node:http';
import { StageLinqBridge } from '../../dist/stagelinqBridge.js';

StageLinqBridge.prototype.connect = async function () {};
StageLinqBridge.prototype.disconnect = async function () {};
StageLinqBridge.prototype.getLastBeatAgeMs = () => 0;
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (_port, _host, callback) {
  this.once('listening', () => process.send?.({ port: this.address().port }));
  return listen.call(this, 0, '127.0.0.1', callback);
};
await import('../../dist/index.js');
