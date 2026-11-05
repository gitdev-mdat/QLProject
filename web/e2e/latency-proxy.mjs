// TCP proxy that adds a fixed one-way delay to every chunk in both directions, to model the distance between the
// server and Postgres (e.g. Vercel iad1 → Supabase ap-northeast-1 ≈ 125 ms round trip, measured from /health).
// Order is preserved because every chunk waits the same amount. Local measurement aid only.
// Usage: node web/e2e/latency-proxy.mjs <listenPort> <targetHost:port> <roundTripMs>
import net from 'node:net';

const [listen = '55433', target = '127.0.0.1:55432', rtt = '125'] = process.argv.slice(2);
const [host, port] = target.split(':');
const oneWay = Number(rtt) / 2;

function delayed(from, to) {
  from.on('data', chunk => setTimeout(() => { if (!to.destroyed) to.write(chunk); }, oneWay));
  from.on('end', () => setTimeout(() => to.end(), oneWay));
  from.on('error', () => to.destroy());
}

net.createServer(client => {
  const upstream = net.connect(Number(port), host);
  delayed(client, upstream);
  delayed(upstream, client);
}).listen(Number(listen), '127.0.0.1', () => console.log(`latency proxy 127.0.0.1:${listen} → ${target} (+${rtt} ms RTT)`));
