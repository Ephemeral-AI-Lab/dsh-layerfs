import net from 'node:net';
const server = net.createServer(client => {
  const upstream = net.createConnection({host:'127.0.0.1',port:15236});
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
});
server.listen(15237,'172.17.0.1',()=>console.log('LayerFS verification proxy relay ready on Docker bridge only'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
