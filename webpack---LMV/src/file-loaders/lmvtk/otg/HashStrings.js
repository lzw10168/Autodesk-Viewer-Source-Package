const TO_HEX = new Array(256);
for (let i = 0; i < 256; i++) {
    let s = i.toString(16);
    if (s.length === 1)
        s = "0" + s;
    TO_HEX[i] = s;
}

//Most common case is for SHA1 hashes, which are 20 bytes
var tmpArr20 = new Array(20);

var tmpArr10 = new Array(10);

//Converts the input byte array into a string of half the length
//by packing two bytes into each string character (JS strings are two bytes per char)
function binToPackedString(buffer, offset, length) {
    var res = (length === 20) ? tmpArr10 : [];

    for (var i = 0; i < length; i += 2) {
        var b0 = buffer[offset + i];
        var b1 = buffer[offset + i + 1];
        res[i / 2] = b1 << 8 | b0;
    }

    return String.fromCharCode.apply(null, res);
}

//Converts from UCS16 packed string (two bytes per character) to
//regular ASCII string of 4x the length
function unpackHexString(s) {
    var res = (s.length === 10) ? tmpArr20 : [];

    for (var i = 0; i < s.length; i++) {
        var bytes = s.charCodeAt(i);
        res[2 * i] = TO_HEX[bytes & 0xff];
        res[2 * i + 1] = TO_HEX[(bytes >> 8) & 0xff];
    }

    return res.join("");
}

function packedToBin(str, buf, offset) {
    for (let i = 0; i < str.length; i++) {
        let bytes = str.charCodeAt(i);
        buf[offset + 2 * i] = bytes & 0xff;
        buf[offset + 2 * i + 1] = (bytes >> 8) & 0xff;
    }
}

module.exports = {
    binToPackedString,
    unpackHexString,
    packedToBin
};