const { Receiver } = require('sacn');

const sACN = new Receiver({
    universes: [19, 20, 21],
});

sACN.on('packet', (packet) => {
    console.log('got dmx data:', packet.payload);
    console.log('Packet:', packet);
});


sACN.on('PacketCorruption', () => {});
sACN.on('PacketOutOfOrder', () => {});

sACN.on('error', () => {});

setInterval(() => {}, 1000);