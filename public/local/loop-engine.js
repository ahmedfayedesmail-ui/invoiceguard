var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/base64-js/index.js
var require_base64_js = __commonJS({
  "node_modules/base64-js/index.js"(exports) {
    "use strict";
    init_buffer_shim();
    exports.byteLength = byteLength;
    exports.toByteArray = toByteArray;
    exports.fromByteArray = fromByteArray;
    var lookup = [];
    var revLookup = [];
    var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
    var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (i = 0, len = code.length; i < len; ++i) {
      lookup[i] = code[i];
      revLookup[code.charCodeAt(i)] = i;
    }
    var i;
    var len;
    revLookup["-".charCodeAt(0)] = 62;
    revLookup["_".charCodeAt(0)] = 63;
    function getLens(b642) {
      var len2 = b642.length;
      if (len2 % 4 > 0) {
        throw new Error("Invalid string. Length must be a multiple of 4");
      }
      var validLen = b642.indexOf("=");
      if (validLen === -1) validLen = len2;
      var placeHoldersLen = validLen === len2 ? 0 : 4 - validLen % 4;
      return [validLen, placeHoldersLen];
    }
    function byteLength(b642) {
      var lens = getLens(b642);
      var validLen = lens[0];
      var placeHoldersLen = lens[1];
      return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
    }
    function _byteLength(b642, validLen, placeHoldersLen) {
      return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
    }
    function toByteArray(b642) {
      var tmp;
      var lens = getLens(b642);
      var validLen = lens[0];
      var placeHoldersLen = lens[1];
      var arr = new Arr(_byteLength(b642, validLen, placeHoldersLen));
      var curByte = 0;
      var len2 = placeHoldersLen > 0 ? validLen - 4 : validLen;
      var i2;
      for (i2 = 0; i2 < len2; i2 += 4) {
        tmp = revLookup[b642.charCodeAt(i2)] << 18 | revLookup[b642.charCodeAt(i2 + 1)] << 12 | revLookup[b642.charCodeAt(i2 + 2)] << 6 | revLookup[b642.charCodeAt(i2 + 3)];
        arr[curByte++] = tmp >> 16 & 255;
        arr[curByte++] = tmp >> 8 & 255;
        arr[curByte++] = tmp & 255;
      }
      if (placeHoldersLen === 2) {
        tmp = revLookup[b642.charCodeAt(i2)] << 2 | revLookup[b642.charCodeAt(i2 + 1)] >> 4;
        arr[curByte++] = tmp & 255;
      }
      if (placeHoldersLen === 1) {
        tmp = revLookup[b642.charCodeAt(i2)] << 10 | revLookup[b642.charCodeAt(i2 + 1)] << 4 | revLookup[b642.charCodeAt(i2 + 2)] >> 2;
        arr[curByte++] = tmp >> 8 & 255;
        arr[curByte++] = tmp & 255;
      }
      return arr;
    }
    function tripletToBase64(num2) {
      return lookup[num2 >> 18 & 63] + lookup[num2 >> 12 & 63] + lookup[num2 >> 6 & 63] + lookup[num2 & 63];
    }
    function encodeChunk(uint8, start, end) {
      var tmp;
      var output = [];
      for (var i2 = start; i2 < end; i2 += 3) {
        tmp = (uint8[i2] << 16 & 16711680) + (uint8[i2 + 1] << 8 & 65280) + (uint8[i2 + 2] & 255);
        output.push(tripletToBase64(tmp));
      }
      return output.join("");
    }
    function fromByteArray(uint8) {
      var tmp;
      var len2 = uint8.length;
      var extraBytes = len2 % 3;
      var parts = [];
      var maxChunkLength = 16383;
      for (var i2 = 0, len22 = len2 - extraBytes; i2 < len22; i2 += maxChunkLength) {
        parts.push(encodeChunk(uint8, i2, i2 + maxChunkLength > len22 ? len22 : i2 + maxChunkLength));
      }
      if (extraBytes === 1) {
        tmp = uint8[len2 - 1];
        parts.push(
          lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "=="
        );
      } else if (extraBytes === 2) {
        tmp = (uint8[len2 - 2] << 8) + uint8[len2 - 1];
        parts.push(
          lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "="
        );
      }
      return parts.join("");
    }
  }
});

// node_modules/ieee754/index.js
var require_ieee754 = __commonJS({
  "node_modules/ieee754/index.js"(exports) {
    init_buffer_shim();
    exports.read = function(buffer, offset, isLE, mLen, nBytes) {
      var e, m;
      var eLen = nBytes * 8 - mLen - 1;
      var eMax = (1 << eLen) - 1;
      var eBias = eMax >> 1;
      var nBits = -7;
      var i = isLE ? nBytes - 1 : 0;
      var d = isLE ? -1 : 1;
      var s = buffer[offset + i];
      i += d;
      e = s & (1 << -nBits) - 1;
      s >>= -nBits;
      nBits += eLen;
      for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {
      }
      m = e & (1 << -nBits) - 1;
      e >>= -nBits;
      nBits += mLen;
      for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {
      }
      if (e === 0) {
        e = 1 - eBias;
      } else if (e === eMax) {
        return m ? NaN : (s ? -1 : 1) * Infinity;
      } else {
        m = m + Math.pow(2, mLen);
        e = e - eBias;
      }
      return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
    };
    exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
      var e, m, c2;
      var eLen = nBytes * 8 - mLen - 1;
      var eMax = (1 << eLen) - 1;
      var eBias = eMax >> 1;
      var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
      var i = isLE ? 0 : nBytes - 1;
      var d = isLE ? 1 : -1;
      var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
      value = Math.abs(value);
      if (isNaN(value) || value === Infinity) {
        m = isNaN(value) ? 1 : 0;
        e = eMax;
      } else {
        e = Math.floor(Math.log(value) / Math.LN2);
        if (value * (c2 = Math.pow(2, -e)) < 1) {
          e--;
          c2 *= 2;
        }
        if (e + eBias >= 1) {
          value += rt / c2;
        } else {
          value += rt * Math.pow(2, 1 - eBias);
        }
        if (value * c2 >= 2) {
          e++;
          c2 /= 2;
        }
        if (e + eBias >= eMax) {
          m = 0;
          e = eMax;
        } else if (e + eBias >= 1) {
          m = (value * c2 - 1) * Math.pow(2, mLen);
          e = e + eBias;
        } else {
          m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
          e = 0;
        }
      }
      for (; mLen >= 8; buffer[offset + i] = m & 255, i += d, m /= 256, mLen -= 8) {
      }
      e = e << mLen | m;
      eLen += mLen;
      for (; eLen > 0; buffer[offset + i] = e & 255, i += d, e /= 256, eLen -= 8) {
      }
      buffer[offset + i - d] |= s * 128;
    };
  }
});

// node_modules/buffer/index.js
var require_buffer = __commonJS({
  "node_modules/buffer/index.js"(exports) {
    "use strict";
    init_buffer_shim();
    var base64 = require_base64_js();
    var ieee754 = require_ieee754();
    var customInspectSymbol = typeof Symbol === "function" && typeof Symbol["for"] === "function" ? Symbol["for"]("nodejs.util.inspect.custom") : null;
    exports.Buffer = Buffer3;
    exports.SlowBuffer = SlowBuffer;
    exports.INSPECT_MAX_BYTES = 50;
    var K_MAX_LENGTH = 2147483647;
    exports.kMaxLength = K_MAX_LENGTH;
    Buffer3.TYPED_ARRAY_SUPPORT = typedArraySupport();
    if (!Buffer3.TYPED_ARRAY_SUPPORT && typeof console !== "undefined" && typeof console.error === "function") {
      console.error(
        "This browser lacks typed array (Uint8Array) support which is required by `buffer` v5.x. Use `buffer` v4.x if you require old browser support."
      );
    }
    function typedArraySupport() {
      try {
        const arr = new Uint8Array(1);
        const proto = { foo: function() {
          return 42;
        } };
        Object.setPrototypeOf(proto, Uint8Array.prototype);
        Object.setPrototypeOf(arr, proto);
        return arr.foo() === 42;
      } catch (e) {
        return false;
      }
    }
    Object.defineProperty(Buffer3.prototype, "parent", {
      enumerable: true,
      get: function() {
        if (!Buffer3.isBuffer(this)) return void 0;
        return this.buffer;
      }
    });
    Object.defineProperty(Buffer3.prototype, "offset", {
      enumerable: true,
      get: function() {
        if (!Buffer3.isBuffer(this)) return void 0;
        return this.byteOffset;
      }
    });
    function createBuffer(length) {
      if (length > K_MAX_LENGTH) {
        throw new RangeError('The value "' + length + '" is invalid for option "size"');
      }
      const buf = new Uint8Array(length);
      Object.setPrototypeOf(buf, Buffer3.prototype);
      return buf;
    }
    function Buffer3(arg, encodingOrOffset, length) {
      if (typeof arg === "number") {
        if (typeof encodingOrOffset === "string") {
          throw new TypeError(
            'The "string" argument must be of type string. Received type number'
          );
        }
        return allocUnsafe(arg);
      }
      return from(arg, encodingOrOffset, length);
    }
    Buffer3.poolSize = 8192;
    function from(value, encodingOrOffset, length) {
      if (typeof value === "string") {
        return fromString(value, encodingOrOffset);
      }
      if (ArrayBuffer.isView(value)) {
        return fromArrayView(value);
      }
      if (value == null) {
        throw new TypeError(
          "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
        );
      }
      if (isInstance(value, ArrayBuffer) || value && isInstance(value.buffer, ArrayBuffer)) {
        return fromArrayBuffer(value, encodingOrOffset, length);
      }
      if (typeof SharedArrayBuffer !== "undefined" && (isInstance(value, SharedArrayBuffer) || value && isInstance(value.buffer, SharedArrayBuffer))) {
        return fromArrayBuffer(value, encodingOrOffset, length);
      }
      if (typeof value === "number") {
        throw new TypeError(
          'The "value" argument must not be of type number. Received type number'
        );
      }
      const valueOf = value.valueOf && value.valueOf();
      if (valueOf != null && valueOf !== value) {
        return Buffer3.from(valueOf, encodingOrOffset, length);
      }
      const b = fromObject(value);
      if (b) return b;
      if (typeof Symbol !== "undefined" && Symbol.toPrimitive != null && typeof value[Symbol.toPrimitive] === "function") {
        return Buffer3.from(value[Symbol.toPrimitive]("string"), encodingOrOffset, length);
      }
      throw new TypeError(
        "The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type " + typeof value
      );
    }
    Buffer3.from = function(value, encodingOrOffset, length) {
      return from(value, encodingOrOffset, length);
    };
    Object.setPrototypeOf(Buffer3.prototype, Uint8Array.prototype);
    Object.setPrototypeOf(Buffer3, Uint8Array);
    function assertSize(size) {
      if (typeof size !== "number") {
        throw new TypeError('"size" argument must be of type number');
      } else if (size < 0) {
        throw new RangeError('The value "' + size + '" is invalid for option "size"');
      }
    }
    function alloc(size, fill, encoding) {
      assertSize(size);
      if (size <= 0) {
        return createBuffer(size);
      }
      if (fill !== void 0) {
        return typeof encoding === "string" ? createBuffer(size).fill(fill, encoding) : createBuffer(size).fill(fill);
      }
      return createBuffer(size);
    }
    Buffer3.alloc = function(size, fill, encoding) {
      return alloc(size, fill, encoding);
    };
    function allocUnsafe(size) {
      assertSize(size);
      return createBuffer(size < 0 ? 0 : checked(size) | 0);
    }
    Buffer3.allocUnsafe = function(size) {
      return allocUnsafe(size);
    };
    Buffer3.allocUnsafeSlow = function(size) {
      return allocUnsafe(size);
    };
    function fromString(string, encoding) {
      if (typeof encoding !== "string" || encoding === "") {
        encoding = "utf8";
      }
      if (!Buffer3.isEncoding(encoding)) {
        throw new TypeError("Unknown encoding: " + encoding);
      }
      const length = byteLength(string, encoding) | 0;
      let buf = createBuffer(length);
      const actual = buf.write(string, encoding);
      if (actual !== length) {
        buf = buf.slice(0, actual);
      }
      return buf;
    }
    function fromArrayLike(array) {
      const length = array.length < 0 ? 0 : checked(array.length) | 0;
      const buf = createBuffer(length);
      for (let i = 0; i < length; i += 1) {
        buf[i] = array[i] & 255;
      }
      return buf;
    }
    function fromArrayView(arrayView) {
      if (isInstance(arrayView, Uint8Array)) {
        const copy = new Uint8Array(arrayView);
        return fromArrayBuffer(copy.buffer, copy.byteOffset, copy.byteLength);
      }
      return fromArrayLike(arrayView);
    }
    function fromArrayBuffer(array, byteOffset, length) {
      if (byteOffset < 0 || array.byteLength < byteOffset) {
        throw new RangeError('"offset" is outside of buffer bounds');
      }
      if (array.byteLength < byteOffset + (length || 0)) {
        throw new RangeError('"length" is outside of buffer bounds');
      }
      let buf;
      if (byteOffset === void 0 && length === void 0) {
        buf = new Uint8Array(array);
      } else if (length === void 0) {
        buf = new Uint8Array(array, byteOffset);
      } else {
        buf = new Uint8Array(array, byteOffset, length);
      }
      Object.setPrototypeOf(buf, Buffer3.prototype);
      return buf;
    }
    function fromObject(obj) {
      if (Buffer3.isBuffer(obj)) {
        const len = checked(obj.length) | 0;
        const buf = createBuffer(len);
        if (buf.length === 0) {
          return buf;
        }
        obj.copy(buf, 0, 0, len);
        return buf;
      }
      if (obj.length !== void 0) {
        if (typeof obj.length !== "number" || numberIsNaN(obj.length)) {
          return createBuffer(0);
        }
        return fromArrayLike(obj);
      }
      if (obj.type === "Buffer" && Array.isArray(obj.data)) {
        return fromArrayLike(obj.data);
      }
    }
    function checked(length) {
      if (length >= K_MAX_LENGTH) {
        throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x" + K_MAX_LENGTH.toString(16) + " bytes");
      }
      return length | 0;
    }
    function SlowBuffer(length) {
      if (+length != length) {
        length = 0;
      }
      return Buffer3.alloc(+length);
    }
    Buffer3.isBuffer = function isBuffer(b) {
      return b != null && b._isBuffer === true && b !== Buffer3.prototype;
    };
    Buffer3.compare = function compare(a, b) {
      if (isInstance(a, Uint8Array)) a = Buffer3.from(a, a.offset, a.byteLength);
      if (isInstance(b, Uint8Array)) b = Buffer3.from(b, b.offset, b.byteLength);
      if (!Buffer3.isBuffer(a) || !Buffer3.isBuffer(b)) {
        throw new TypeError(
          'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
        );
      }
      if (a === b) return 0;
      let x = a.length;
      let y = b.length;
      for (let i = 0, len = Math.min(x, y); i < len; ++i) {
        if (a[i] !== b[i]) {
          x = a[i];
          y = b[i];
          break;
        }
      }
      if (x < y) return -1;
      if (y < x) return 1;
      return 0;
    };
    Buffer3.isEncoding = function isEncoding(encoding) {
      switch (String(encoding).toLowerCase()) {
        case "hex":
        case "utf8":
        case "utf-8":
        case "ascii":
        case "latin1":
        case "binary":
        case "base64":
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return true;
        default:
          return false;
      }
    };
    Buffer3.concat = function concat(list, length) {
      if (!Array.isArray(list)) {
        throw new TypeError('"list" argument must be an Array of Buffers');
      }
      if (list.length === 0) {
        return Buffer3.alloc(0);
      }
      let i;
      if (length === void 0) {
        length = 0;
        for (i = 0; i < list.length; ++i) {
          length += list[i].length;
        }
      }
      const buffer = Buffer3.allocUnsafe(length);
      let pos = 0;
      for (i = 0; i < list.length; ++i) {
        let buf = list[i];
        if (isInstance(buf, Uint8Array)) {
          if (pos + buf.length > buffer.length) {
            if (!Buffer3.isBuffer(buf)) buf = Buffer3.from(buf);
            buf.copy(buffer, pos);
          } else {
            Uint8Array.prototype.set.call(
              buffer,
              buf,
              pos
            );
          }
        } else if (!Buffer3.isBuffer(buf)) {
          throw new TypeError('"list" argument must be an Array of Buffers');
        } else {
          buf.copy(buffer, pos);
        }
        pos += buf.length;
      }
      return buffer;
    };
    function byteLength(string, encoding) {
      if (Buffer3.isBuffer(string)) {
        return string.length;
      }
      if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
        return string.byteLength;
      }
      if (typeof string !== "string") {
        throw new TypeError(
          'The "string" argument must be one of type string, Buffer, or ArrayBuffer. Received type ' + typeof string
        );
      }
      const len = string.length;
      const mustMatch = arguments.length > 2 && arguments[2] === true;
      if (!mustMatch && len === 0) return 0;
      let loweredCase = false;
      for (; ; ) {
        switch (encoding) {
          case "ascii":
          case "latin1":
          case "binary":
            return len;
          case "utf8":
          case "utf-8":
            return utf8ToBytes(string).length;
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return len * 2;
          case "hex":
            return len >>> 1;
          case "base64":
            return base64ToBytes(string).length;
          default:
            if (loweredCase) {
              return mustMatch ? -1 : utf8ToBytes(string).length;
            }
            encoding = ("" + encoding).toLowerCase();
            loweredCase = true;
        }
      }
    }
    Buffer3.byteLength = byteLength;
    function slowToString(encoding, start, end) {
      let loweredCase = false;
      if (start === void 0 || start < 0) {
        start = 0;
      }
      if (start > this.length) {
        return "";
      }
      if (end === void 0 || end > this.length) {
        end = this.length;
      }
      if (end <= 0) {
        return "";
      }
      end >>>= 0;
      start >>>= 0;
      if (end <= start) {
        return "";
      }
      if (!encoding) encoding = "utf8";
      while (true) {
        switch (encoding) {
          case "hex":
            return hexSlice(this, start, end);
          case "utf8":
          case "utf-8":
            return utf8Slice(this, start, end);
          case "ascii":
            return asciiSlice(this, start, end);
          case "latin1":
          case "binary":
            return latin1Slice(this, start, end);
          case "base64":
            return base64Slice(this, start, end);
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return utf16leSlice(this, start, end);
          default:
            if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
            encoding = (encoding + "").toLowerCase();
            loweredCase = true;
        }
      }
    }
    Buffer3.prototype._isBuffer = true;
    function swap(b, n, m) {
      const i = b[n];
      b[n] = b[m];
      b[m] = i;
    }
    Buffer3.prototype.swap16 = function swap16() {
      const len = this.length;
      if (len % 2 !== 0) {
        throw new RangeError("Buffer size must be a multiple of 16-bits");
      }
      for (let i = 0; i < len; i += 2) {
        swap(this, i, i + 1);
      }
      return this;
    };
    Buffer3.prototype.swap32 = function swap32() {
      const len = this.length;
      if (len % 4 !== 0) {
        throw new RangeError("Buffer size must be a multiple of 32-bits");
      }
      for (let i = 0; i < len; i += 4) {
        swap(this, i, i + 3);
        swap(this, i + 1, i + 2);
      }
      return this;
    };
    Buffer3.prototype.swap64 = function swap64() {
      const len = this.length;
      if (len % 8 !== 0) {
        throw new RangeError("Buffer size must be a multiple of 64-bits");
      }
      for (let i = 0; i < len; i += 8) {
        swap(this, i, i + 7);
        swap(this, i + 1, i + 6);
        swap(this, i + 2, i + 5);
        swap(this, i + 3, i + 4);
      }
      return this;
    };
    Buffer3.prototype.toString = function toString() {
      const length = this.length;
      if (length === 0) return "";
      if (arguments.length === 0) return utf8Slice(this, 0, length);
      return slowToString.apply(this, arguments);
    };
    Buffer3.prototype.toLocaleString = Buffer3.prototype.toString;
    Buffer3.prototype.equals = function equals(b) {
      if (!Buffer3.isBuffer(b)) throw new TypeError("Argument must be a Buffer");
      if (this === b) return true;
      return Buffer3.compare(this, b) === 0;
    };
    Buffer3.prototype.inspect = function inspect() {
      let str = "";
      const max = exports.INSPECT_MAX_BYTES;
      str = this.toString("hex", 0, max).replace(/(.{2})/g, "$1 ").trim();
      if (this.length > max) str += " ... ";
      return "<Buffer " + str + ">";
    };
    if (customInspectSymbol) {
      Buffer3.prototype[customInspectSymbol] = Buffer3.prototype.inspect;
    }
    Buffer3.prototype.compare = function compare(target, start, end, thisStart, thisEnd) {
      if (isInstance(target, Uint8Array)) {
        target = Buffer3.from(target, target.offset, target.byteLength);
      }
      if (!Buffer3.isBuffer(target)) {
        throw new TypeError(
          'The "target" argument must be one of type Buffer or Uint8Array. Received type ' + typeof target
        );
      }
      if (start === void 0) {
        start = 0;
      }
      if (end === void 0) {
        end = target ? target.length : 0;
      }
      if (thisStart === void 0) {
        thisStart = 0;
      }
      if (thisEnd === void 0) {
        thisEnd = this.length;
      }
      if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
        throw new RangeError("out of range index");
      }
      if (thisStart >= thisEnd && start >= end) {
        return 0;
      }
      if (thisStart >= thisEnd) {
        return -1;
      }
      if (start >= end) {
        return 1;
      }
      start >>>= 0;
      end >>>= 0;
      thisStart >>>= 0;
      thisEnd >>>= 0;
      if (this === target) return 0;
      let x = thisEnd - thisStart;
      let y = end - start;
      const len = Math.min(x, y);
      const thisCopy = this.slice(thisStart, thisEnd);
      const targetCopy = target.slice(start, end);
      for (let i = 0; i < len; ++i) {
        if (thisCopy[i] !== targetCopy[i]) {
          x = thisCopy[i];
          y = targetCopy[i];
          break;
        }
      }
      if (x < y) return -1;
      if (y < x) return 1;
      return 0;
    };
    function bidirectionalIndexOf(buffer, val, byteOffset, encoding, dir) {
      if (buffer.length === 0) return -1;
      if (typeof byteOffset === "string") {
        encoding = byteOffset;
        byteOffset = 0;
      } else if (byteOffset > 2147483647) {
        byteOffset = 2147483647;
      } else if (byteOffset < -2147483648) {
        byteOffset = -2147483648;
      }
      byteOffset = +byteOffset;
      if (numberIsNaN(byteOffset)) {
        byteOffset = dir ? 0 : buffer.length - 1;
      }
      if (byteOffset < 0) byteOffset = buffer.length + byteOffset;
      if (byteOffset >= buffer.length) {
        if (dir) return -1;
        else byteOffset = buffer.length - 1;
      } else if (byteOffset < 0) {
        if (dir) byteOffset = 0;
        else return -1;
      }
      if (typeof val === "string") {
        val = Buffer3.from(val, encoding);
      }
      if (Buffer3.isBuffer(val)) {
        if (val.length === 0) {
          return -1;
        }
        return arrayIndexOf(buffer, val, byteOffset, encoding, dir);
      } else if (typeof val === "number") {
        val = val & 255;
        if (typeof Uint8Array.prototype.indexOf === "function") {
          if (dir) {
            return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset);
          } else {
            return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset);
          }
        }
        return arrayIndexOf(buffer, [val], byteOffset, encoding, dir);
      }
      throw new TypeError("val must be string, number or Buffer");
    }
    function arrayIndexOf(arr, val, byteOffset, encoding, dir) {
      let indexSize = 1;
      let arrLength = arr.length;
      let valLength = val.length;
      if (encoding !== void 0) {
        encoding = String(encoding).toLowerCase();
        if (encoding === "ucs2" || encoding === "ucs-2" || encoding === "utf16le" || encoding === "utf-16le") {
          if (arr.length < 2 || val.length < 2) {
            return -1;
          }
          indexSize = 2;
          arrLength /= 2;
          valLength /= 2;
          byteOffset /= 2;
        }
      }
      function read(buf, i2) {
        if (indexSize === 1) {
          return buf[i2];
        } else {
          return buf.readUInt16BE(i2 * indexSize);
        }
      }
      let i;
      if (dir) {
        let foundIndex = -1;
        for (i = byteOffset; i < arrLength; i++) {
          if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
            if (foundIndex === -1) foundIndex = i;
            if (i - foundIndex + 1 === valLength) return foundIndex * indexSize;
          } else {
            if (foundIndex !== -1) i -= i - foundIndex;
            foundIndex = -1;
          }
        }
      } else {
        if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength;
        for (i = byteOffset; i >= 0; i--) {
          let found = true;
          for (let j = 0; j < valLength; j++) {
            if (read(arr, i + j) !== read(val, j)) {
              found = false;
              break;
            }
          }
          if (found) return i;
        }
      }
      return -1;
    }
    Buffer3.prototype.includes = function includes(val, byteOffset, encoding) {
      return this.indexOf(val, byteOffset, encoding) !== -1;
    };
    Buffer3.prototype.indexOf = function indexOf(val, byteOffset, encoding) {
      return bidirectionalIndexOf(this, val, byteOffset, encoding, true);
    };
    Buffer3.prototype.lastIndexOf = function lastIndexOf(val, byteOffset, encoding) {
      return bidirectionalIndexOf(this, val, byteOffset, encoding, false);
    };
    function hexWrite(buf, string, offset, length) {
      offset = Number(offset) || 0;
      const remaining = buf.length - offset;
      if (!length) {
        length = remaining;
      } else {
        length = Number(length);
        if (length > remaining) {
          length = remaining;
        }
      }
      const strLen = string.length;
      if (length > strLen / 2) {
        length = strLen / 2;
      }
      let i;
      for (i = 0; i < length; ++i) {
        const parsed = parseInt(string.substr(i * 2, 2), 16);
        if (numberIsNaN(parsed)) return i;
        buf[offset + i] = parsed;
      }
      return i;
    }
    function utf8Write(buf, string, offset, length) {
      return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length);
    }
    function asciiWrite(buf, string, offset, length) {
      return blitBuffer(asciiToBytes(string), buf, offset, length);
    }
    function base64Write(buf, string, offset, length) {
      return blitBuffer(base64ToBytes(string), buf, offset, length);
    }
    function ucs2Write(buf, string, offset, length) {
      return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length);
    }
    Buffer3.prototype.write = function write(string, offset, length, encoding) {
      if (offset === void 0) {
        encoding = "utf8";
        length = this.length;
        offset = 0;
      } else if (length === void 0 && typeof offset === "string") {
        encoding = offset;
        length = this.length;
        offset = 0;
      } else if (isFinite(offset)) {
        offset = offset >>> 0;
        if (isFinite(length)) {
          length = length >>> 0;
          if (encoding === void 0) encoding = "utf8";
        } else {
          encoding = length;
          length = void 0;
        }
      } else {
        throw new Error(
          "Buffer.write(string, encoding, offset[, length]) is no longer supported"
        );
      }
      const remaining = this.length - offset;
      if (length === void 0 || length > remaining) length = remaining;
      if (string.length > 0 && (length < 0 || offset < 0) || offset > this.length) {
        throw new RangeError("Attempt to write outside buffer bounds");
      }
      if (!encoding) encoding = "utf8";
      let loweredCase = false;
      for (; ; ) {
        switch (encoding) {
          case "hex":
            return hexWrite(this, string, offset, length);
          case "utf8":
          case "utf-8":
            return utf8Write(this, string, offset, length);
          case "ascii":
          case "latin1":
          case "binary":
            return asciiWrite(this, string, offset, length);
          case "base64":
            return base64Write(this, string, offset, length);
          case "ucs2":
          case "ucs-2":
          case "utf16le":
          case "utf-16le":
            return ucs2Write(this, string, offset, length);
          default:
            if (loweredCase) throw new TypeError("Unknown encoding: " + encoding);
            encoding = ("" + encoding).toLowerCase();
            loweredCase = true;
        }
      }
    };
    Buffer3.prototype.toJSON = function toJSON() {
      return {
        type: "Buffer",
        data: Array.prototype.slice.call(this._arr || this, 0)
      };
    };
    function base64Slice(buf, start, end) {
      if (start === 0 && end === buf.length) {
        return base64.fromByteArray(buf);
      } else {
        return base64.fromByteArray(buf.slice(start, end));
      }
    }
    function utf8Slice(buf, start, end) {
      end = Math.min(buf.length, end);
      const res = [];
      let i = start;
      while (i < end) {
        const firstByte = buf[i];
        let codePoint = null;
        let bytesPerSequence = firstByte > 239 ? 4 : firstByte > 223 ? 3 : firstByte > 191 ? 2 : 1;
        if (i + bytesPerSequence <= end) {
          let secondByte, thirdByte, fourthByte, tempCodePoint;
          switch (bytesPerSequence) {
            case 1:
              if (firstByte < 128) {
                codePoint = firstByte;
              }
              break;
            case 2:
              secondByte = buf[i + 1];
              if ((secondByte & 192) === 128) {
                tempCodePoint = (firstByte & 31) << 6 | secondByte & 63;
                if (tempCodePoint > 127) {
                  codePoint = tempCodePoint;
                }
              }
              break;
            case 3:
              secondByte = buf[i + 1];
              thirdByte = buf[i + 2];
              if ((secondByte & 192) === 128 && (thirdByte & 192) === 128) {
                tempCodePoint = (firstByte & 15) << 12 | (secondByte & 63) << 6 | thirdByte & 63;
                if (tempCodePoint > 2047 && (tempCodePoint < 55296 || tempCodePoint > 57343)) {
                  codePoint = tempCodePoint;
                }
              }
              break;
            case 4:
              secondByte = buf[i + 1];
              thirdByte = buf[i + 2];
              fourthByte = buf[i + 3];
              if ((secondByte & 192) === 128 && (thirdByte & 192) === 128 && (fourthByte & 192) === 128) {
                tempCodePoint = (firstByte & 15) << 18 | (secondByte & 63) << 12 | (thirdByte & 63) << 6 | fourthByte & 63;
                if (tempCodePoint > 65535 && tempCodePoint < 1114112) {
                  codePoint = tempCodePoint;
                }
              }
          }
        }
        if (codePoint === null) {
          codePoint = 65533;
          bytesPerSequence = 1;
        } else if (codePoint > 65535) {
          codePoint -= 65536;
          res.push(codePoint >>> 10 & 1023 | 55296);
          codePoint = 56320 | codePoint & 1023;
        }
        res.push(codePoint);
        i += bytesPerSequence;
      }
      return decodeCodePointsArray(res);
    }
    var MAX_ARGUMENTS_LENGTH = 4096;
    function decodeCodePointsArray(codePoints) {
      const len = codePoints.length;
      if (len <= MAX_ARGUMENTS_LENGTH) {
        return String.fromCharCode.apply(String, codePoints);
      }
      let res = "";
      let i = 0;
      while (i < len) {
        res += String.fromCharCode.apply(
          String,
          codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
        );
      }
      return res;
    }
    function asciiSlice(buf, start, end) {
      let ret = "";
      end = Math.min(buf.length, end);
      for (let i = start; i < end; ++i) {
        ret += String.fromCharCode(buf[i] & 127);
      }
      return ret;
    }
    function latin1Slice(buf, start, end) {
      let ret = "";
      end = Math.min(buf.length, end);
      for (let i = start; i < end; ++i) {
        ret += String.fromCharCode(buf[i]);
      }
      return ret;
    }
    function hexSlice(buf, start, end) {
      const len = buf.length;
      if (!start || start < 0) start = 0;
      if (!end || end < 0 || end > len) end = len;
      let out = "";
      for (let i = start; i < end; ++i) {
        out += hexSliceLookupTable[buf[i]];
      }
      return out;
    }
    function utf16leSlice(buf, start, end) {
      const bytes = buf.slice(start, end);
      let res = "";
      for (let i = 0; i < bytes.length - 1; i += 2) {
        res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256);
      }
      return res;
    }
    Buffer3.prototype.slice = function slice(start, end) {
      const len = this.length;
      start = ~~start;
      end = end === void 0 ? len : ~~end;
      if (start < 0) {
        start += len;
        if (start < 0) start = 0;
      } else if (start > len) {
        start = len;
      }
      if (end < 0) {
        end += len;
        if (end < 0) end = 0;
      } else if (end > len) {
        end = len;
      }
      if (end < start) end = start;
      const newBuf = this.subarray(start, end);
      Object.setPrototypeOf(newBuf, Buffer3.prototype);
      return newBuf;
    };
    function checkOffset(offset, ext, length) {
      if (offset % 1 !== 0 || offset < 0) throw new RangeError("offset is not uint");
      if (offset + ext > length) throw new RangeError("Trying to access beyond buffer length");
    }
    Buffer3.prototype.readUintLE = Buffer3.prototype.readUIntLE = function readUIntLE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) checkOffset(offset, byteLength2, this.length);
      let val = this[offset];
      let mul = 1;
      let i = 0;
      while (++i < byteLength2 && (mul *= 256)) {
        val += this[offset + i] * mul;
      }
      return val;
    };
    Buffer3.prototype.readUintBE = Buffer3.prototype.readUIntBE = function readUIntBE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) {
        checkOffset(offset, byteLength2, this.length);
      }
      let val = this[offset + --byteLength2];
      let mul = 1;
      while (byteLength2 > 0 && (mul *= 256)) {
        val += this[offset + --byteLength2] * mul;
      }
      return val;
    };
    Buffer3.prototype.readUint8 = Buffer3.prototype.readUInt8 = function readUInt8(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 1, this.length);
      return this[offset];
    };
    Buffer3.prototype.readUint16LE = Buffer3.prototype.readUInt16LE = function readUInt16LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      return this[offset] | this[offset + 1] << 8;
    };
    Buffer3.prototype.readUint16BE = Buffer3.prototype.readUInt16BE = function readUInt16BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      return this[offset] << 8 | this[offset + 1];
    };
    Buffer3.prototype.readUint32LE = Buffer3.prototype.readUInt32LE = function readUInt32LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return (this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16) + this[offset + 3] * 16777216;
    };
    Buffer3.prototype.readUint32BE = Buffer3.prototype.readUInt32BE = function readUInt32BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return this[offset] * 16777216 + (this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3]);
    };
    Buffer3.prototype.readBigUInt64LE = defineBigIntMethod(function readBigUInt64LE(offset) {
      offset = offset >>> 0;
      validateNumber(offset, "offset");
      const first = this[offset];
      const last = this[offset + 7];
      if (first === void 0 || last === void 0) {
        boundsError(offset, this.length - 8);
      }
      const lo = first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24;
      const hi = this[++offset] + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + last * 2 ** 24;
      return BigInt(lo) + (BigInt(hi) << BigInt(32));
    });
    Buffer3.prototype.readBigUInt64BE = defineBigIntMethod(function readBigUInt64BE(offset) {
      offset = offset >>> 0;
      validateNumber(offset, "offset");
      const first = this[offset];
      const last = this[offset + 7];
      if (first === void 0 || last === void 0) {
        boundsError(offset, this.length - 8);
      }
      const hi = first * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
      const lo = this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last;
      return (BigInt(hi) << BigInt(32)) + BigInt(lo);
    });
    Buffer3.prototype.readIntLE = function readIntLE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) checkOffset(offset, byteLength2, this.length);
      let val = this[offset];
      let mul = 1;
      let i = 0;
      while (++i < byteLength2 && (mul *= 256)) {
        val += this[offset + i] * mul;
      }
      mul *= 128;
      if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
      return val;
    };
    Buffer3.prototype.readIntBE = function readIntBE(offset, byteLength2, noAssert) {
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) checkOffset(offset, byteLength2, this.length);
      let i = byteLength2;
      let mul = 1;
      let val = this[offset + --i];
      while (i > 0 && (mul *= 256)) {
        val += this[offset + --i] * mul;
      }
      mul *= 128;
      if (val >= mul) val -= Math.pow(2, 8 * byteLength2);
      return val;
    };
    Buffer3.prototype.readInt8 = function readInt8(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 1, this.length);
      if (!(this[offset] & 128)) return this[offset];
      return (255 - this[offset] + 1) * -1;
    };
    Buffer3.prototype.readInt16LE = function readInt16LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      const val = this[offset] | this[offset + 1] << 8;
      return val & 32768 ? val | 4294901760 : val;
    };
    Buffer3.prototype.readInt16BE = function readInt16BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 2, this.length);
      const val = this[offset + 1] | this[offset] << 8;
      return val & 32768 ? val | 4294901760 : val;
    };
    Buffer3.prototype.readInt32LE = function readInt32LE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return this[offset] | this[offset + 1] << 8 | this[offset + 2] << 16 | this[offset + 3] << 24;
    };
    Buffer3.prototype.readInt32BE = function readInt32BE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return this[offset] << 24 | this[offset + 1] << 16 | this[offset + 2] << 8 | this[offset + 3];
    };
    Buffer3.prototype.readBigInt64LE = defineBigIntMethod(function readBigInt64LE(offset) {
      offset = offset >>> 0;
      validateNumber(offset, "offset");
      const first = this[offset];
      const last = this[offset + 7];
      if (first === void 0 || last === void 0) {
        boundsError(offset, this.length - 8);
      }
      const val = this[offset + 4] + this[offset + 5] * 2 ** 8 + this[offset + 6] * 2 ** 16 + (last << 24);
      return (BigInt(val) << BigInt(32)) + BigInt(first + this[++offset] * 2 ** 8 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 24);
    });
    Buffer3.prototype.readBigInt64BE = defineBigIntMethod(function readBigInt64BE(offset) {
      offset = offset >>> 0;
      validateNumber(offset, "offset");
      const first = this[offset];
      const last = this[offset + 7];
      if (first === void 0 || last === void 0) {
        boundsError(offset, this.length - 8);
      }
      const val = (first << 24) + // Overflow
      this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + this[++offset];
      return (BigInt(val) << BigInt(32)) + BigInt(this[++offset] * 2 ** 24 + this[++offset] * 2 ** 16 + this[++offset] * 2 ** 8 + last);
    });
    Buffer3.prototype.readFloatLE = function readFloatLE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return ieee754.read(this, offset, true, 23, 4);
    };
    Buffer3.prototype.readFloatBE = function readFloatBE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 4, this.length);
      return ieee754.read(this, offset, false, 23, 4);
    };
    Buffer3.prototype.readDoubleLE = function readDoubleLE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 8, this.length);
      return ieee754.read(this, offset, true, 52, 8);
    };
    Buffer3.prototype.readDoubleBE = function readDoubleBE(offset, noAssert) {
      offset = offset >>> 0;
      if (!noAssert) checkOffset(offset, 8, this.length);
      return ieee754.read(this, offset, false, 52, 8);
    };
    function checkInt(buf, value, offset, ext, max, min) {
      if (!Buffer3.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance');
      if (value > max || value < min) throw new RangeError('"value" argument is out of bounds');
      if (offset + ext > buf.length) throw new RangeError("Index out of range");
    }
    Buffer3.prototype.writeUintLE = Buffer3.prototype.writeUIntLE = function writeUIntLE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) {
        const maxBytes = Math.pow(2, 8 * byteLength2) - 1;
        checkInt(this, value, offset, byteLength2, maxBytes, 0);
      }
      let mul = 1;
      let i = 0;
      this[offset] = value & 255;
      while (++i < byteLength2 && (mul *= 256)) {
        this[offset + i] = value / mul & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeUintBE = Buffer3.prototype.writeUIntBE = function writeUIntBE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      byteLength2 = byteLength2 >>> 0;
      if (!noAssert) {
        const maxBytes = Math.pow(2, 8 * byteLength2) - 1;
        checkInt(this, value, offset, byteLength2, maxBytes, 0);
      }
      let i = byteLength2 - 1;
      let mul = 1;
      this[offset + i] = value & 255;
      while (--i >= 0 && (mul *= 256)) {
        this[offset + i] = value / mul & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeUint8 = Buffer3.prototype.writeUInt8 = function writeUInt8(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 1, 255, 0);
      this[offset] = value & 255;
      return offset + 1;
    };
    Buffer3.prototype.writeUint16LE = Buffer3.prototype.writeUInt16LE = function writeUInt16LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
      this[offset] = value & 255;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    };
    Buffer3.prototype.writeUint16BE = Buffer3.prototype.writeUInt16BE = function writeUInt16BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 65535, 0);
      this[offset] = value >>> 8;
      this[offset + 1] = value & 255;
      return offset + 2;
    };
    Buffer3.prototype.writeUint32LE = Buffer3.prototype.writeUInt32LE = function writeUInt32LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
      this[offset + 3] = value >>> 24;
      this[offset + 2] = value >>> 16;
      this[offset + 1] = value >>> 8;
      this[offset] = value & 255;
      return offset + 4;
    };
    Buffer3.prototype.writeUint32BE = Buffer3.prototype.writeUInt32BE = function writeUInt32BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 4294967295, 0);
      this[offset] = value >>> 24;
      this[offset + 1] = value >>> 16;
      this[offset + 2] = value >>> 8;
      this[offset + 3] = value & 255;
      return offset + 4;
    };
    function wrtBigUInt64LE(buf, value, offset, min, max) {
      checkIntBI(value, min, max, buf, offset, 7);
      let lo = Number(value & BigInt(4294967295));
      buf[offset++] = lo;
      lo = lo >> 8;
      buf[offset++] = lo;
      lo = lo >> 8;
      buf[offset++] = lo;
      lo = lo >> 8;
      buf[offset++] = lo;
      let hi = Number(value >> BigInt(32) & BigInt(4294967295));
      buf[offset++] = hi;
      hi = hi >> 8;
      buf[offset++] = hi;
      hi = hi >> 8;
      buf[offset++] = hi;
      hi = hi >> 8;
      buf[offset++] = hi;
      return offset;
    }
    function wrtBigUInt64BE(buf, value, offset, min, max) {
      checkIntBI(value, min, max, buf, offset, 7);
      let lo = Number(value & BigInt(4294967295));
      buf[offset + 7] = lo;
      lo = lo >> 8;
      buf[offset + 6] = lo;
      lo = lo >> 8;
      buf[offset + 5] = lo;
      lo = lo >> 8;
      buf[offset + 4] = lo;
      let hi = Number(value >> BigInt(32) & BigInt(4294967295));
      buf[offset + 3] = hi;
      hi = hi >> 8;
      buf[offset + 2] = hi;
      hi = hi >> 8;
      buf[offset + 1] = hi;
      hi = hi >> 8;
      buf[offset] = hi;
      return offset + 8;
    }
    Buffer3.prototype.writeBigUInt64LE = defineBigIntMethod(function writeBigUInt64LE(value, offset = 0) {
      return wrtBigUInt64LE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
    });
    Buffer3.prototype.writeBigUInt64BE = defineBigIntMethod(function writeBigUInt64BE(value, offset = 0) {
      return wrtBigUInt64BE(this, value, offset, BigInt(0), BigInt("0xffffffffffffffff"));
    });
    Buffer3.prototype.writeIntLE = function writeIntLE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        const limit = Math.pow(2, 8 * byteLength2 - 1);
        checkInt(this, value, offset, byteLength2, limit - 1, -limit);
      }
      let i = 0;
      let mul = 1;
      let sub = 0;
      this[offset] = value & 255;
      while (++i < byteLength2 && (mul *= 256)) {
        if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
          sub = 1;
        }
        this[offset + i] = (value / mul >> 0) - sub & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeIntBE = function writeIntBE(value, offset, byteLength2, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        const limit = Math.pow(2, 8 * byteLength2 - 1);
        checkInt(this, value, offset, byteLength2, limit - 1, -limit);
      }
      let i = byteLength2 - 1;
      let mul = 1;
      let sub = 0;
      this[offset + i] = value & 255;
      while (--i >= 0 && (mul *= 256)) {
        if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
          sub = 1;
        }
        this[offset + i] = (value / mul >> 0) - sub & 255;
      }
      return offset + byteLength2;
    };
    Buffer3.prototype.writeInt8 = function writeInt8(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 1, 127, -128);
      if (value < 0) value = 255 + value + 1;
      this[offset] = value & 255;
      return offset + 1;
    };
    Buffer3.prototype.writeInt16LE = function writeInt16LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
      this[offset] = value & 255;
      this[offset + 1] = value >>> 8;
      return offset + 2;
    };
    Buffer3.prototype.writeInt16BE = function writeInt16BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 2, 32767, -32768);
      this[offset] = value >>> 8;
      this[offset + 1] = value & 255;
      return offset + 2;
    };
    Buffer3.prototype.writeInt32LE = function writeInt32LE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
      this[offset] = value & 255;
      this[offset + 1] = value >>> 8;
      this[offset + 2] = value >>> 16;
      this[offset + 3] = value >>> 24;
      return offset + 4;
    };
    Buffer3.prototype.writeInt32BE = function writeInt32BE(value, offset, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) checkInt(this, value, offset, 4, 2147483647, -2147483648);
      if (value < 0) value = 4294967295 + value + 1;
      this[offset] = value >>> 24;
      this[offset + 1] = value >>> 16;
      this[offset + 2] = value >>> 8;
      this[offset + 3] = value & 255;
      return offset + 4;
    };
    Buffer3.prototype.writeBigInt64LE = defineBigIntMethod(function writeBigInt64LE(value, offset = 0) {
      return wrtBigUInt64LE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
    });
    Buffer3.prototype.writeBigInt64BE = defineBigIntMethod(function writeBigInt64BE(value, offset = 0) {
      return wrtBigUInt64BE(this, value, offset, -BigInt("0x8000000000000000"), BigInt("0x7fffffffffffffff"));
    });
    function checkIEEE754(buf, value, offset, ext, max, min) {
      if (offset + ext > buf.length) throw new RangeError("Index out of range");
      if (offset < 0) throw new RangeError("Index out of range");
    }
    function writeFloat(buf, value, offset, littleEndian, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        checkIEEE754(buf, value, offset, 4, 34028234663852886e22, -34028234663852886e22);
      }
      ieee754.write(buf, value, offset, littleEndian, 23, 4);
      return offset + 4;
    }
    Buffer3.prototype.writeFloatLE = function writeFloatLE(value, offset, noAssert) {
      return writeFloat(this, value, offset, true, noAssert);
    };
    Buffer3.prototype.writeFloatBE = function writeFloatBE(value, offset, noAssert) {
      return writeFloat(this, value, offset, false, noAssert);
    };
    function writeDouble(buf, value, offset, littleEndian, noAssert) {
      value = +value;
      offset = offset >>> 0;
      if (!noAssert) {
        checkIEEE754(buf, value, offset, 8, 17976931348623157e292, -17976931348623157e292);
      }
      ieee754.write(buf, value, offset, littleEndian, 52, 8);
      return offset + 8;
    }
    Buffer3.prototype.writeDoubleLE = function writeDoubleLE(value, offset, noAssert) {
      return writeDouble(this, value, offset, true, noAssert);
    };
    Buffer3.prototype.writeDoubleBE = function writeDoubleBE(value, offset, noAssert) {
      return writeDouble(this, value, offset, false, noAssert);
    };
    Buffer3.prototype.copy = function copy(target, targetStart, start, end) {
      if (!Buffer3.isBuffer(target)) throw new TypeError("argument should be a Buffer");
      if (!start) start = 0;
      if (!end && end !== 0) end = this.length;
      if (targetStart >= target.length) targetStart = target.length;
      if (!targetStart) targetStart = 0;
      if (end > 0 && end < start) end = start;
      if (end === start) return 0;
      if (target.length === 0 || this.length === 0) return 0;
      if (targetStart < 0) {
        throw new RangeError("targetStart out of bounds");
      }
      if (start < 0 || start >= this.length) throw new RangeError("Index out of range");
      if (end < 0) throw new RangeError("sourceEnd out of bounds");
      if (end > this.length) end = this.length;
      if (target.length - targetStart < end - start) {
        end = target.length - targetStart + start;
      }
      const len = end - start;
      if (this === target && typeof Uint8Array.prototype.copyWithin === "function") {
        this.copyWithin(targetStart, start, end);
      } else {
        Uint8Array.prototype.set.call(
          target,
          this.subarray(start, end),
          targetStart
        );
      }
      return len;
    };
    Buffer3.prototype.fill = function fill(val, start, end, encoding) {
      if (typeof val === "string") {
        if (typeof start === "string") {
          encoding = start;
          start = 0;
          end = this.length;
        } else if (typeof end === "string") {
          encoding = end;
          end = this.length;
        }
        if (encoding !== void 0 && typeof encoding !== "string") {
          throw new TypeError("encoding must be a string");
        }
        if (typeof encoding === "string" && !Buffer3.isEncoding(encoding)) {
          throw new TypeError("Unknown encoding: " + encoding);
        }
        if (val.length === 1) {
          const code = val.charCodeAt(0);
          if (encoding === "utf8" && code < 128 || encoding === "latin1") {
            val = code;
          }
        }
      } else if (typeof val === "number") {
        val = val & 255;
      } else if (typeof val === "boolean") {
        val = Number(val);
      }
      if (start < 0 || this.length < start || this.length < end) {
        throw new RangeError("Out of range index");
      }
      if (end <= start) {
        return this;
      }
      start = start >>> 0;
      end = end === void 0 ? this.length : end >>> 0;
      if (!val) val = 0;
      let i;
      if (typeof val === "number") {
        for (i = start; i < end; ++i) {
          this[i] = val;
        }
      } else {
        const bytes = Buffer3.isBuffer(val) ? val : Buffer3.from(val, encoding);
        const len = bytes.length;
        if (len === 0) {
          throw new TypeError('The value "' + val + '" is invalid for argument "value"');
        }
        for (i = 0; i < end - start; ++i) {
          this[i + start] = bytes[i % len];
        }
      }
      return this;
    };
    var errors = {};
    function E(sym, getMessage, Base) {
      errors[sym] = class NodeError extends Base {
        constructor() {
          super();
          Object.defineProperty(this, "message", {
            value: getMessage.apply(this, arguments),
            writable: true,
            configurable: true
          });
          this.name = `${this.name} [${sym}]`;
          this.stack;
          delete this.name;
        }
        get code() {
          return sym;
        }
        set code(value) {
          Object.defineProperty(this, "code", {
            configurable: true,
            enumerable: true,
            value,
            writable: true
          });
        }
        toString() {
          return `${this.name} [${sym}]: ${this.message}`;
        }
      };
    }
    E(
      "ERR_BUFFER_OUT_OF_BOUNDS",
      function(name) {
        if (name) {
          return `${name} is outside of buffer bounds`;
        }
        return "Attempt to access memory outside buffer bounds";
      },
      RangeError
    );
    E(
      "ERR_INVALID_ARG_TYPE",
      function(name, actual) {
        return `The "${name}" argument must be of type number. Received type ${typeof actual}`;
      },
      TypeError
    );
    E(
      "ERR_OUT_OF_RANGE",
      function(str, range, input) {
        let msg = `The value of "${str}" is out of range.`;
        let received = input;
        if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
          received = addNumericalSeparator(String(input));
        } else if (typeof input === "bigint") {
          received = String(input);
          if (input > BigInt(2) ** BigInt(32) || input < -(BigInt(2) ** BigInt(32))) {
            received = addNumericalSeparator(received);
          }
          received += "n";
        }
        msg += ` It must be ${range}. Received ${received}`;
        return msg;
      },
      RangeError
    );
    function addNumericalSeparator(val) {
      let res = "";
      let i = val.length;
      const start = val[0] === "-" ? 1 : 0;
      for (; i >= start + 4; i -= 3) {
        res = `_${val.slice(i - 3, i)}${res}`;
      }
      return `${val.slice(0, i)}${res}`;
    }
    function checkBounds(buf, offset, byteLength2) {
      validateNumber(offset, "offset");
      if (buf[offset] === void 0 || buf[offset + byteLength2] === void 0) {
        boundsError(offset, buf.length - (byteLength2 + 1));
      }
    }
    function checkIntBI(value, min, max, buf, offset, byteLength2) {
      if (value > max || value < min) {
        const n = typeof min === "bigint" ? "n" : "";
        let range;
        if (byteLength2 > 3) {
          if (min === 0 || min === BigInt(0)) {
            range = `>= 0${n} and < 2${n} ** ${(byteLength2 + 1) * 8}${n}`;
          } else {
            range = `>= -(2${n} ** ${(byteLength2 + 1) * 8 - 1}${n}) and < 2 ** ${(byteLength2 + 1) * 8 - 1}${n}`;
          }
        } else {
          range = `>= ${min}${n} and <= ${max}${n}`;
        }
        throw new errors.ERR_OUT_OF_RANGE("value", range, value);
      }
      checkBounds(buf, offset, byteLength2);
    }
    function validateNumber(value, name) {
      if (typeof value !== "number") {
        throw new errors.ERR_INVALID_ARG_TYPE(name, "number", value);
      }
    }
    function boundsError(value, length, type) {
      if (Math.floor(value) !== value) {
        validateNumber(value, type);
        throw new errors.ERR_OUT_OF_RANGE(type || "offset", "an integer", value);
      }
      if (length < 0) {
        throw new errors.ERR_BUFFER_OUT_OF_BOUNDS();
      }
      throw new errors.ERR_OUT_OF_RANGE(
        type || "offset",
        `>= ${type ? 1 : 0} and <= ${length}`,
        value
      );
    }
    var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g;
    function base64clean(str) {
      str = str.split("=")[0];
      str = str.trim().replace(INVALID_BASE64_RE, "");
      if (str.length < 2) return "";
      while (str.length % 4 !== 0) {
        str = str + "=";
      }
      return str;
    }
    function utf8ToBytes(string, units) {
      units = units || Infinity;
      let codePoint;
      const length = string.length;
      let leadSurrogate = null;
      const bytes = [];
      for (let i = 0; i < length; ++i) {
        codePoint = string.charCodeAt(i);
        if (codePoint > 55295 && codePoint < 57344) {
          if (!leadSurrogate) {
            if (codePoint > 56319) {
              if ((units -= 3) > -1) bytes.push(239, 191, 189);
              continue;
            } else if (i + 1 === length) {
              if ((units -= 3) > -1) bytes.push(239, 191, 189);
              continue;
            }
            leadSurrogate = codePoint;
            continue;
          }
          if (codePoint < 56320) {
            if ((units -= 3) > -1) bytes.push(239, 191, 189);
            leadSurrogate = codePoint;
            continue;
          }
          codePoint = (leadSurrogate - 55296 << 10 | codePoint - 56320) + 65536;
        } else if (leadSurrogate) {
          if ((units -= 3) > -1) bytes.push(239, 191, 189);
        }
        leadSurrogate = null;
        if (codePoint < 128) {
          if ((units -= 1) < 0) break;
          bytes.push(codePoint);
        } else if (codePoint < 2048) {
          if ((units -= 2) < 0) break;
          bytes.push(
            codePoint >> 6 | 192,
            codePoint & 63 | 128
          );
        } else if (codePoint < 65536) {
          if ((units -= 3) < 0) break;
          bytes.push(
            codePoint >> 12 | 224,
            codePoint >> 6 & 63 | 128,
            codePoint & 63 | 128
          );
        } else if (codePoint < 1114112) {
          if ((units -= 4) < 0) break;
          bytes.push(
            codePoint >> 18 | 240,
            codePoint >> 12 & 63 | 128,
            codePoint >> 6 & 63 | 128,
            codePoint & 63 | 128
          );
        } else {
          throw new Error("Invalid code point");
        }
      }
      return bytes;
    }
    function asciiToBytes(str) {
      const byteArray = [];
      for (let i = 0; i < str.length; ++i) {
        byteArray.push(str.charCodeAt(i) & 255);
      }
      return byteArray;
    }
    function utf16leToBytes(str, units) {
      let c2, hi, lo;
      const byteArray = [];
      for (let i = 0; i < str.length; ++i) {
        if ((units -= 2) < 0) break;
        c2 = str.charCodeAt(i);
        hi = c2 >> 8;
        lo = c2 % 256;
        byteArray.push(lo);
        byteArray.push(hi);
      }
      return byteArray;
    }
    function base64ToBytes(str) {
      return base64.toByteArray(base64clean(str));
    }
    function blitBuffer(src, dst, offset, length) {
      let i;
      for (i = 0; i < length; ++i) {
        if (i + offset >= dst.length || i >= src.length) break;
        dst[i + offset] = src[i];
      }
      return i;
    }
    function isInstance(obj, type) {
      return obj instanceof type || obj != null && obj.constructor != null && obj.constructor.name != null && obj.constructor.name === type.name;
    }
    function numberIsNaN(obj) {
      return obj !== obj;
    }
    var hexSliceLookupTable = (function() {
      const alphabet = "0123456789abcdef";
      const table = new Array(256);
      for (let i = 0; i < 16; ++i) {
        const i16 = i * 16;
        for (let j = 0; j < 16; ++j) {
          table[i16 + j] = alphabet[i] + alphabet[j];
        }
      }
      return table;
    })();
    function defineBigIntMethod(fn) {
      return typeof BigInt === "undefined" ? BufferBigIntNotDefined : fn;
    }
    function BufferBigIntNotDefined() {
      throw new Error("BigInt not supported");
    }
  }
});

// web/buffer-shim.js
var import_buffer;
var init_buffer_shim = __esm({
  "web/buffer-shim.js"() {
    import_buffer = __toESM(require_buffer(), 1);
  }
});

// web/loop-entry.js
init_buffer_shim();

// src/loop/store.js
init_buffer_shim();

// src/loop/project.js
init_buffer_shim();

// src/reconcile.js
init_buffer_shim();

// src/manual.js
init_buffer_shim();

// src/vidr.js
init_buffer_shim();

// src/txid.js
init_buffer_shim();
function classifyTransactionId(id, type) {
  const s = String(id ?? ""), t = String(type ?? "");
  if (!/^Correction/.test(s)) return { role: null, format: null, unknown: false };
  const p = s.split(":"), full = (...i) => i.every((k) => p[k] !== void 0 && p[k] !== "");
  if (p[0] === "CorrectionReversal" && p.length === 3 && full(1, 2)) return t === "REFUND" ? { role: "REVERSAL", format: "reversal", unknown: false } : { role: null, format: null, unknown: true, why: `CorrectionReversal id with transaction type ${JSON.stringify(t)} (expected REFUND)` };
  if (p[0] === "Correction" && p.length === 4 && p[1] === "" && full(2, 3)) return t === "SHIPMENT" ? { role: "CORRECTED", format: "current", unknown: false } : { role: null, format: null, unknown: true, why: `Correction id with transaction type ${JSON.stringify(t)} (expected SHIPMENT)` };
  if (p[0] === "Correction" && p.length === 3 && full(1, 2)) return t === "SHIPMENT" ? { role: "CORRECTED", format: "legacy", unknown: false } : { role: null, format: null, unknown: true, why: `Correction id with transaction type ${JSON.stringify(t)} (expected SHIPMENT)` };
  return { role: null, format: null, unknown: true, why: 'the id starts with "Correction" but matches none of the known shapes' };
}

// src/manual.js
var MAX_ROWS = 2e4;
function parseTable(text) {
  text = String(text ?? "").replace(/^\uFEFF/, "");
  const all = text.split(/\r?\n/), isBlank = (l) => !l.trim();
  let lo = 0, hi = all.length;
  while (lo < hi && isBlank(all[lo])) lo++;
  while (hi > lo && isBlank(all[hi - 1])) hi--;
  const lines = all.slice(lo, hi);
  if (lines.length < 2) return { head: [], rows: [], blankLines: 0, raggedRows: 0 };
  const delim = (lines[0].match(/\t/g) || []).length >= 2 ? "	" : (lines[0].match(/;/g) || []).length >= 2 ? ";" : ",";
  if (delim !== "	") return { head: [], rows: [], blankLines: 0, raggedRows: 0, unsupported: "This does not look like a tab-separated Amazon flat file. Download the report as a text (tab-delimited) file, not Excel or CSV." };
  const head = lines[0].split("	").map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const body = lines.slice(1), kept = body.slice(0, MAX_ROWS), blankLines = kept.filter(isBlank).length;
  const records = kept.filter((l) => !isBlank(l));
  let raggedRows = 0;
  const rows = records.map((l) => {
    const c2 = l.split("	");
    if (c2.length !== head.length) raggedRows++;
    return Object.fromEntries(head.map((h, i) => [h, (c2[i] ?? "").trim().replace(/^"|"$/g, "")]));
  });
  return { head, rows, truncated: body.length > MAX_ROWS, blankLines, raggedRows };
}

// src/reconcile.js
var STATUS_MAP = Object.freeze({
  InvoicePending: "PENDING",
  CreditNotePending: "PENDING",
  InvoiceProcessing: "PROCESSING",
  CreditNoteProcessing: "PROCESSING",
  InvoiceUploaded: "ACCEPTED",
  CreditNoteUploaded: "ACCEPTED",
  InvoiceRejected: "REJECTED",
  CreditNoteRejected: "REJECTED",
  // Amazon made the document: the seller owes no upload. Kept strictly apart from every seller-upload state.
  InvoiceCreatedByAmazon: "CREATED_BY_AMAZON",
  CreditNoteCreatedByAmazon: "CREATED_BY_AMAZON",
  // Amazon did NOT calculate the tax: the SELLER must upload the invoice. This creates an obligation, it is not a shrug.
  NoTaxCalculated: "SELLER_UPLOAD_REQUIRED"
});
var KNOWN_STATUSES = Object.freeze(Object.keys(STATUS_MAP));
var TRANSACTION_TYPES = Object.freeze(["SHIPMENT", "REFUND", "RETURN"]);
var FAMILY = Object.freeze(Object.fromEntries(KNOWN_STATUSES.map((k) => [k, k.startsWith("Invoice") ? "invoice" : k.startsWith("CreditNote") ? "credit" : "any"])));
function statusTypeCompatibility(raw, type) {
  const fam = FAMILY[raw], t = String(type ?? "").trim();
  if (!fam) return { ok: true };
  if (!TRANSACTION_TYPES.includes(t)) return { ok: false, code: "UNKNOWN_TRANSACTION_TYPE", why: `the transaction type ${JSON.stringify(t)} is not SHIPMENT, REFUND or RETURN` };
  if (fam === "any") return { ok: true };
  if (fam === "invoice" && t === "SHIPMENT") return { ok: true };
  if (fam === "credit" && (t === "REFUND" || t === "RETURN")) return { ok: true };
  return { ok: false, code: "FAMILY_MISMATCH", why: fam === "invoice" ? `${raw} is an invoice status and belongs with SHIPMENT, not ${t}` : `${raw} is a credit note status and belongs with REFUND or RETURN, not ${t}` };
}
var REPORT_TYPE = "GET_FLAT_FILE_VAT_INVOICE_DATA_REPORT";
var REQUIRED_COLUMNS = ["marketplace-id", "order-id", "order-item-id", "shipping-id", "transaction-id", "transaction-type", "invoice-status", "invoice-number", "order-date"];
var KEY_FIELDS = ["marketplace-id", "order-id", "shipping-id", "transaction-id", "transaction-type"];
var DAY = 864e5;
var validDay = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
var iso3 = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
var declaredDay = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? "").trim());
  return m && validDay(+m[1], +m[2], +m[3]) ? iso3(+m[1], +m[2], +m[3]) : null;
};
var isoDay = declaredDay;
var FILE_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
function fileDateReadings(v) {
  const t = String(v ?? "").trim();
  if (t === "") return { kind: "blank" };
  const m = FILE_DATE.exec(t);
  if (!m) return { kind: "unrecognized" };
  const a = +m[1], b = +m[2], y = +m[3];
  const dayFirst = validDay(y, b, a) ? iso3(y, b, a) : null, monthFirst = validDay(y, a, b) ? iso3(y, a, b) : null;
  if (!dayFirst && !monthFirst) return { kind: "impossible" };
  return { kind: "ok", dayFirst, monthFirst, provesDayFirst: !!dayFirst && a > 12, provesMonthFirst: !!monthFirst && b > 12 };
}
function readFileDates(rows) {
  const rd = rows.map((r) => fileDateReadings(r["order-date"]));
  const count = (k) => rd.filter((x) => x.kind === k).length;
  const out = { blank: count("blank"), unrecognized: count("unrecognized"), impossible: count("impossible"), order: null, basis: null, days: rows.map(() => null), contradiction: false, monthFirstExample: null, needsConfirmation: false };
  const dayProof = rd.filter((x) => x.provesDayFirst).length, monthIdx = rd.findIndex((x) => x.provesMonthFirst);
  if (dayProof && monthIdx >= 0) {
    out.contradiction = true;
    out.monthFirstExample = String(rows[monthIdx]["order-date"]).trim();
    return out;
  }
  if (monthIdx >= 0) {
    out.monthFirstExample = String(rows[monthIdx]["order-date"]).trim();
    return out;
  }
  const valid = rd.filter((x) => x.kind === "ok").length;
  if (!valid) return out;
  out.order = "DAY_FIRST";
  out.basis = dayProof ? "proven by values in the file" : "not proven by the file: every valid date is ambiguous, so the seller must confirm DD/MM/YYYY (a declaration, not verified by us)";
  out.needsConfirmation = !dayProof;
  out.days = rd.map((x) => x.kind === "ok" ? x.dayFirst : null);
  rd.forEach((x, i) => {
    if (x.kind === "ok" && out.days[i] === null) out.impossible++;
  });
  return out;
}
var ROW_DAY = /* @__PURE__ */ new WeakMap();
var blank = (v) => !String(v ?? "").trim();
var CONTRACT_VERSION = "v1.5";
var CONTRACT_LABEL = `EVIDENCE-CONTRACT ${CONTRACT_VERSION}`;
var ms = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
var uniq = (a) => [...new Set(a)];
var check = (name, ok, how, detail) => ({ name, ok, how, detail });
function classifyImport(imp, parsed) {
  const d = imp.declared ?? {}, head = parsed.head ?? [], problems = [], add = (code, text) => problems.push({ code, text });
  const missingCols = REQUIRED_COLUMNS.filter((c2) => !head.includes(c2));
  if (parsed.unsupported) add("UNSUPPORTED_FORMAT", parsed.unsupported);
  if (missingCols.length) add("MISSING_COLUMNS", `Columns missing from the file: ${missingCols.join(", ")}`);
  if (parsed.truncated) add("TRUNCATED_FILE", "Only part of the file was read: the reader stops after a fixed number of rows and this file has more. Nothing from a partly read file can be shown as accepted.");
  const options = String(d.options ?? "UNKNOWN").toUpperCase();
  if (options !== "ALL") add("NOT_ALL_STATUSES", options === "PENDING_ONLY" ? "Declared as the pending-only report: it leaves out invoices Amazon already accepted." : "The report version was not declared (all statuses or pending only).");
  const from = isoDay(d.rangeFrom), to = isoDay(d.rangeTo);
  const spanDays = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1 : null;
  if (options === "ALL") {
    if (!from || !to) add("NO_RANGE", "No date range was declared.");
    else if (spanDays < 1) add("RANGE_INVALID", "The declared date range ends before it starts.");
    else if (spanDays > 30) add("RANGE_TOO_LONG", `The declared date range is ${spanDays} days. Amazon's all-statuses report allows at most 30.`);
  }
  const fd = readFileDates(parsed.rows);
  parsed.rows.forEach((r, i) => ROW_DAY.set(r, fd.days[i]));
  if (fd.monthFirstExample && !fd.contradiction) add("MONTH_FIRST_NOT_SUPPORTED", `The order dates in this file look month-first (for example ${JSON.stringify(fd.monthFirstExample)}). Amazon documents DD/MM/YYYY for this report, so this file cannot be read as it is. Download the report again and load it unchanged.`);
  if (fd.contradiction) add("DATE_ORDER_CONTRADICTION", "The order dates in this file contradict each other: some can only be day/month/year and others only month/day/year. We do not guess. Download the report again and load it unchanged.");
  if (fd.unrecognized) add("UNRECOGNIZED_DATE_FORMAT", `${fd.unrecognized} order date(s) in the file are not in a format we recognise. Amazon documents DD/MM/YYYY (for example 17/05/2018). This file is not shown as a complete read.`);
  if (fd.impossible) add("MISSING_OR_INVALID_ORDER_DATE", `${fd.impossible} order date(s) are not real calendar days (for example 31/02/2018) or cannot be read in the order the rest of the file uses.`);
  if (fd.blank) add("MISSING_OR_INVALID_ORDER_DATE", `${fd.blank} row(s) have an empty order date. Every row needs one, so this file is not shown as a complete read.`);
  if (parsed.blankLines) add("BLANK_LINE_IN_DATA", `${parsed.blankLines} blank line(s) sit between records. A blank line can hide a broken row, so the file is not shown as a complete read. Download the report again and load it unchanged.`);
  if (parsed.raggedRows) add("RAGGED_ROWS", `${parsed.raggedRows} row(s) have a different number of columns from the header.`);
  const noKey = parsed.rows.filter((r) => KEY_FIELDS.some((k) => blank(r[k]))).length;
  if (noKey) add("ROWS_WITHOUT_KEY", `${noKey} row(s) have a blank marketplace, order, shipping, transaction id or transaction type, so they cannot be tied to a document. They are not dropped: the import is incomplete.`);
  const noReq = parsed.rows.filter((r) => blank(r["order-item-id"]) || blank(r["invoice-status"])).length;
  if (noReq) add("MISSING_REQUIRED_VALUE", `${noReq} row(s) have a blank order-item-id or invoice-status.`);
  const dates = fd.days.filter((x) => x !== null).sort();
  const outside = from && to ? fd.days.filter((x) => x !== null && (x < from || x > to)).length : 0;
  if (outside) add("ROWS_OUTSIDE_RANGE", `${outside} row(s) have an order date outside the declared range. The range is checked against the order date, because Amazon's all-statuses report covers orders placed within the period.`);
  const warnings = [];
  const confirmed = String(d.dateOrderConfirmed ?? "").trim() === "DD/MM/YYYY";
  if (fd.needsConfirmation) warnings.push(confirmed ? "Every valid order date in this file is ambiguous between day/month and month/day. The seller confirmed DD/MM/YYYY at import (declared by the seller, not verified by us)." : "Every valid order date in this file is ambiguous between day/month and month/day. Nothing in the file proves the order, so nothing is shown as accepted until the seller confirms DD/MM/YYYY, the format Amazon documents for this report.");
  const seen = new Set(parsed.rows.map((r) => String(r["invoice-status"] ?? "").trim()));
  if (options === "ALL" && parsed.rows.length && ![...seen].some((s) => ["InvoiceUploaded", "CreditNoteUploaded", "InvoiceProcessing", "CreditNoteProcessing", "InvoiceCreatedByAmazon", "CreditNoteCreatedByAmazon"].includes(s)))
    warnings.push("Declared as all statuses, but the file has only pending, rejected or other not-yet-uploaded rows. It looks like a pending-only report. Check the download.");
  if (parsed.truncated) warnings.push("Only part of this file was read.");
  return {
    id: imp.id,
    fileName: imp.fileName ?? null,
    sha256: imp.sha256 ?? null,
    rows: parsed.rows.length,
    truncated: !!parsed.truncated,
    scope: problems.length ? "INCOMPLETE_SOURCE" : "COMPLETE_SCOPE",
    problems: problems.map((p) => p.text),
    problemCodes: problems.map((p) => p.code),
    warnings,
    declared: { reportType: d.reportType ?? null, options, rangeFrom: from, rangeTo: to, spanDays, marketplace: d.marketplace ?? null, createdAt: d.createdAt ?? null, downloadedAt: d.downloadedAt ?? null, createdAfterUploadConfirmed: d.createdAfterUploadConfirmed === true, dateOrderConfirmed: confirmed ? "DD/MM/YYYY" : null, obtainedHow: d.obtainedHow ?? null, labelledAs: "declared by the seller, not verified by InvoiceGuard" },
    dateOrder: fd.order ? { order: fd.order, basis: fd.basis, provenByFile: !fd.needsConfirmation, sellerConfirmed: fd.needsConfirmation ? confirmed : null, confirmationLabel: fd.needsConfirmation ? "declared by the seller, not verified by InvoiceGuard" : null } : null,
    fileOrderDates: dates.length ? { first: dates[0], last: dates.at(-1) } : null,
    importedAt: imp.importedAt ?? null
  };
}
function effectiveTime(imp) {
  const d = imp.declared ?? {};
  for (const [k, v] of [["createdAt (seller-confirmed)", d.createdAt], ["downloadedAt (declared)", d.downloadedAt], ["importedAt", imp.importedAt]]) {
    const t = ms(v);
    if (t !== null) return { t, basis: k, iso: new Date(t).toISOString() };
  }
  return { t: null, basis: "none", iso: null };
}
var docKey = (r) => KEY_FIELDS.map((k) => r[k] ?? "").join("|");
function gateAccepted({ cls, truncated, imp, row, invoiceNumber, conflicts }) {
  const d = imp.declared ?? {}, od = ROW_DAY.get(row) ?? null, pre = [];
  pre.push(check("file was read in full", !truncated, "from-file", truncated ? "only part of the file was read" : "all rows were read"));
  pre.push(check("import is complete (every import-level check passed)", cls.scope === "COMPLETE_SCOPE", "from-file", cls.problems.join(" ") || "no import-level problem"));
  pre.push(check("all-status report", cls.declared.options === "ALL", "declared-by-seller", `declared option: ${cls.declared.options}. The file cannot prove which option was used.`));
  pre.push(check("report type stored", d.reportType === REPORT_TYPE, "declared-by-seller", `declared type: ${d.reportType ?? "none"}`));
  pre.push(check("range no longer than 30 days", cls.declared.spanDays !== null && cls.declared.spanDays >= 1 && cls.declared.spanDays <= 30, "from-declared-dates", cls.declared.spanDays === null ? "no range declared" : `${cls.declared.rangeFrom} to ${cls.declared.rangeTo} (${cls.declared.spanDays} days). Checked on the declared dates only.`));
  pre.push(check("range covers the order date", !!(od && cls.declared.rangeFrom && cls.declared.rangeTo && od >= cls.declared.rangeFrom && od <= cls.declared.rangeTo), "from-file", `order-date ${od ?? "blank"} (UTC day) against the declared range`));
  pre.push(check("marketplace matches", !!(d.marketplace && d.marketplace === row["marketplace-id"]), "declared-by-seller", `declared ${d.marketplace ?? "none"}, row ${row["marketplace-id"]}`));
  pre.push(check("report created after the upload", cls.declared.createdAfterUploadConfirmed && ms(d.createdAt) !== null, "declared-by-seller", "The file has no creation time. The seller confirmed it, with a creation time, or it is unmet."));
  {
    const o = cls.dateOrder, conflict = cls.dateOrderConflict ?? null;
    pre.push(check(
      "date order known",
      !!o && (o.provenByFile || o.sellerConfirmed === true && !conflict),
      o && o.provenByFile ? "from-file" : "declared-by-seller",
      !o ? "no readable order date, so the order is not known" : o.provenByFile ? "a value in the file proves DD/MM/YYYY" : conflict ? `the seller confirmed DD/MM/YYYY for this import, but ${conflict}. A confirmation does not carry across files and is not silently overridden.` : o.sellerConfirmed ? "nothing in the file proves the order; the seller confirmed DD/MM/YYYY at import (declared, not verified)" : "nothing in the file proves the order and the seller has not confirmed DD/MM/YYYY"
    ));
  }
  pre.push(check("download time stored", ms(d.downloadedAt) !== null, "declared-by-seller", `downloadedAt: ${d.downloadedAt ?? "none"}`));
  pre.push(check("file hash stored", /^[0-9a-f]{64}$/.test(imp.sha256 ?? ""), "from-file", "SHA-256 of the raw file, computed on this device. It shows the file is unchanged since import, not where it came from."));
  pre.push(check("how the file was obtained stored", !!String(d.obtainedHow ?? "").trim(), "declared-by-seller", d.obtainedHow ?? "none"));
  pre.push(check("document number present", !!invoiceNumber, "from-file", invoiceNumber ?? "invoice-number is blank"));
  pre.push(check("rows agree (no conflict)", !conflicts.length, "from-file", conflicts.join("; ") || "all rows of the document agree"));
  const unmet = pre.filter((p) => !p.ok);
  const reasonCode = !unmet.length ? null : unmet.length === 1 && unmet[0].name === "date order known" && !cls.problems.length ? "DATE_ORDER_UNCONFIRMED" : !truncated ? cls.problemCodes.includes("MISSING_COLUMNS") ? "MISSING_COLUMNS" : cls.problemCodes.includes("MONTH_FIRST_NOT_SUPPORTED") ? "MONTH_FIRST_NOT_SUPPORTED" : cls.problemCodes.includes("UNRECOGNIZED_DATE_FORMAT") ? "UNRECOGNIZED_DATE_FORMAT" : cls.problemCodes.includes("DATE_ORDER_CONTRADICTION") ? "DATE_ORDER_CONTRADICTION" : cls.problemCodes.includes("MISSING_OR_INVALID_ORDER_DATE") ? "MISSING_OR_INVALID_ORDER_DATE" : unmet.some((p) => p.name.startsWith("import is complete")) ? "IMPORT_NOT_COMPLETE" : "PRECONDITION_UNMET" : "TRUNCATED_FILE";
  const onlyDate = unmet.length === 1 && unmet[0].name === "date order known" && !cls.problems.length;
  return { state: !unmet.length ? "ACCEPTED" : onlyDate ? "DATE_ORDER_UNCONFIRMED" : "INCOMPLETE_SOURCE", preconditions: pre, unmet: unmet.map((p) => p.name), unmetDetail: unmet.map((p) => `${p.name} (${p.detail})`).join("; "), reasonCode };
}
function observe(imp, cls, parsed) {
  const obs = /* @__PURE__ */ new Map(), unkeyed = [];
  const et = effectiveTime(imp);
  for (const r of parsed.rows) {
    if (KEY_FIELDS.some((k2) => !String(r[k2] ?? "").trim())) {
      unkeyed.push(r);
      continue;
    }
    const k = docKey(r);
    if (!obs.has(k)) obs.set(k, { key: k, importId: imp.id, et, rows: [], duplicateRows: 0 });
    const o = obs.get(k), same = o.rows.find((x) => JSON.stringify(x) === JSON.stringify(r));
    if (same) o.duplicateRows++;
    else o.rows.push(r);
  }
  for (const o of obs.values()) {
    const raws = uniq(o.rows.map((r) => String(r["invoice-status"] ?? "").trim())), allNums = uniq(o.rows.map((r) => String(r["invoice-number"] ?? "").trim())), nums = allNums.filter((x) => x !== ""), mixedBlank = nums.length >= 1 && allNums.includes("");
    const f = o.rows[0];
    o.parts = Object.fromEntries(KEY_FIELDS.map((k) => [k, f[k]]));
    o.itemIds = uniq(o.rows.map((r) => r["order-item-id"]));
    o.conflicts = [];
    o.mixedBlank = mixedBlank;
    if (raws.length > 1) o.conflicts.push(`Rows of this document disagree on invoice-status: ${raws.map((x) => JSON.stringify(x)).join(" vs ")}`);
    if (nums.length > 1) o.conflicts.push(`Rows of this document carry different invoice numbers: ${nums.join(", ")}`);
    o.raw = raws[0] ?? "";
    o.invoiceNumber = mixedBlank ? null : nums[0] ?? null;
    o.statusDescription = uniq(o.rows.map((r) => String(r["invoice-status-description"] ?? "").trim()).filter((x) => x !== "")).join(" | ") || null;
    const tx = classifyTransactionId(f["transaction-id"], f["transaction-type"]), compat = statusTypeCompatibility(o.raw, f["transaction-type"]);
    o.tx = tx;
    o.reasonCode = null;
    o.why = null;
    if (tx.unknown) {
      o.mapped = "UNKNOWN_TRANSACTION_ID_FORMAT";
      o.why = tx.why;
    } else if (o.conflicts.length) {
      o.mapped = "UNMATCHED";
      o.unmatchedReason = "AMBIGUOUS";
      o.why = o.conflicts.join("; ");
    } else if (mixedBlank) {
      o.mapped = "INVOICE_NUMBER_INCOMPLETE";
      o.why = `Some rows of this document carry the invoice number ${nums.map((x) => JSON.stringify(x)).join(", ")} and others have it blank. A blank is treated as a value, so the rows do not agree.`;
    } else if (!(o.raw in STATUS_MAP)) o.mapped = "UNKNOWN_STATUS";
    else if (!compat.ok) {
      o.mapped = "INCOMPATIBLE_STATUS_AND_TYPE";
      o.why = compat.why;
      o.reasonCode = compat.code;
    } else if (STATUS_MAP[o.raw] === "ACCEPTED") {
      const g = gateAccepted({ cls, truncated: cls.truncated, imp, row: f, invoiceNumber: o.invoiceNumber, conflicts: o.conflicts });
      o.mapped = g.state;
      o.preconditions = g.preconditions;
      o.unmet = g.unmet;
      o.reasonCode = g.reasonCode;
      o.why = g.unmetDetail || null;
    } else o.mapped = STATUS_MAP[o.raw];
    o.times = { reportCreated: { value: imp.declared?.createdAt ?? null, source: "declared by the seller" }, downloaded: { value: imp.declared?.downloadedAt ?? null, source: "declared by the seller" }, imported: { value: imp.importedAt ?? null, source: "recorded by InvoiceGuard at import" } };
  }
  return { observations: [...obs.values()], unkeyed };
}
var EXPLAIN = {
  // Wording rule: a report shows the state it shows on the day it was made. It never shows when that state began, so there is no "accepted on".
  ACCEPTED: (c2) => `Observed as ${c2.raw} in the report dated ${c2.date} ${c2.dn}. Amazon's report shows the final successful state. It does not show when that state began.`,
  PROCESSING: (c2) => `Observed as ${c2.raw} in the report dated ${c2.date} ${c2.dn}: Amazon has the upload and is still processing it.`,
  PENDING: (c2) => `Observed as ${c2.raw} in the report dated ${c2.date} ${c2.dn}: Amazon is waiting for the seller's upload.`,
  SELLER_UPLOAD_REQUIRED: (c2) => `Observed as ${c2.raw} in the report dated ${c2.date} ${c2.dn}. Amazon did not calculate the tax for this transaction, so the seller must upload the invoice. Nothing has been uploaded as far as this report shows. This is an exception.`,
  REJECTED: (c2) => `Observed as ${c2.raw} in the report dated ${c2.date} ${c2.dn}: Amazon found errors in the upload. Amazon says the seller must upload this document again.`,
  CREATED_BY_AMAZON: (c2) => `Observed as ${c2.raw} in the report dated ${c2.date} ${c2.dn}: Amazon made this document itself. The seller has nothing to upload for it.`,
  INCOMPLETE_SOURCE: (c2) => `The file says ${c2.raw}, but it is not shown as accepted. ${c2.why}`,
  UNMATCHED: (c2) => `We could not tie this to one document with confidence: ${c2.why}`,
  UNKNOWN_STATUS: (c2) => `The file has a status we do not recognise (${JSON.stringify(c2.raw)}). We did not guess. This is counted as cannot determine.`,
  UNKNOWN_TRANSACTION_ID_FORMAT: (c2) => `The transaction id starts with "Correction" but is not one of the known shapes (${c2.why}). We did not treat it as a correction and did not treat it as an ordinary transaction. This is counted as cannot determine.`,
  DATE_ORDER_UNCONFIRMED: (c2) => `The file says ${c2.raw}, but it is not shown as accepted: nothing in the file proves whether its dates are day/month or month/day. ${c2.why} Confirm DD/MM/YYYY (the format Amazon documents) when importing, and the other checks will run.`,
  INVOICE_NUMBER_INCOMPLETE: (c2) => `The rows of this document do not agree on the invoice number. ${c2.why} It is not shown as accepted and it is counted as cannot determine.`,
  INCOMPATIBLE_STATUS_AND_TYPE: (c2) => `The status ${c2.raw} cannot go with this transaction type: ${c2.why}. The row is refused. It is not shown as accepted, rejected or pending, and it is counted as cannot determine.`,
  PARTIALLY_ACCEPTED: () => `One side of this correction was observed as accepted and the other was not. The correction counts as open until both sides are.`
};
function reconcile(imports) {
  const importSummaries = [], byDoc = /* @__PURE__ */ new Map(), unkeyedAll = [], warnings = [];
  const pre = imports.map((imp) => {
    const parsed = imp.rows ? { head: Object.keys(imp.rows[0] ?? {}), rows: imp.rows, truncated: !!imp.truncated } : parseTable(imp.text ?? "");
    const cls = classifyImport(imp, parsed);
    return { imp, parsed, cls };
  });
  const monthFirst = pre.filter((x) => x.cls.problemCodes.includes("MONTH_FIRST_NOT_SUPPORTED") || x.cls.problemCodes.includes("DATE_ORDER_CONTRADICTION"));
  const dateOrderConflicts = [];
  for (const x of pre) if (x.cls.dateOrder?.sellerConfirmed) for (const m of monthFirst) {
    if (m.cls.id === x.cls.id) continue;
    x.cls.dateOrderConflict = `import ${m.cls.id} contains dates that look month-first`;
    dateOrderConflicts.push({ confirmedImport: x.cls.id, contradictingImport: m.cls.id, note: "The seller confirmed DD/MM/YYYY for the first import; the second contains a month-first value. Nothing is overridden silently." });
  }
  for (const { imp, parsed, cls } of pre) {
    importSummaries.push(cls);
    if (cls.dateOrderConflict) warnings.push({ importId: imp.id, warning: `The seller confirmed DD/MM/YYYY for this import, but ${cls.dateOrderConflict}. The confirmation is not applied.` });
    cls.warnings.forEach((w) => warnings.push({ importId: imp.id, warning: w }));
    const { observations, unkeyed } = observe(imp, cls, parsed);
    unkeyed.forEach((r) => unkeyedAll.push({ importId: imp.id, row: r }));
    for (const o of observations) {
      o.importScope = cls.scope;
      if (!byDoc.has(o.key)) byDoc.set(o.key, []);
      byDoc.get(o.key).push(o);
    }
  }
  const docs = [];
  const snap = (o) => ({ importId: o.importId, rawStatus: o.raw, mapped: o.mapped, times: o.times, rows: o.rows, invoiceNumber: o.invoiceNumber, transactionId: o.parts["transaction-id"], statusDescription: o.statusDescription });
  for (const [key, list] of byDoc) {
    const sorted = [...list].sort((a, b) => (a.et.t ?? -Infinity) - (b.et.t ?? -Infinity) || String(a.importId).localeCompare(String(b.importId)));
    const last = sorted.at(-1), sameTime = sorted.filter((o) => o.et.t !== null && o.et.t === last.et.t);
    let cur = last, why = null;
    if (sameTime.length > 1 && uniq(sameTime.map((o) => o.mapped + "|" + o.raw)).length > 1) {
      cur = { ...last, mapped: "UNMATCHED", unmatchedReason: "AMBIGUOUS" };
      why = "Two reports with the same time show different statuses for it.";
    }
    if (last.et.t === null && sorted.length > 1) {
      cur = { ...last, mapped: "UNMATCHED", unmatchedReason: "AMBIGUOUS" };
      why = "Reports without any time cannot be put in order.";
    }
    if (!why) why = cur.why;
    const anomalies = [];
    const rank = { PENDING: 0, SELLER_UPLOAD_REQUIRED: 0, PROCESSING: 1, REJECTED: 1, ACCEPTED: 2 };
    const prevBest = sorted.slice(0, -1).filter((o) => o.mapped in rank).sort((a, b) => rank[b.mapped] - rank[a.mapped])[0];
    if (prevBest && cur.mapped in rank && rank[cur.mapped] < rank[prevBest.mapped]) anomalies.push(`A later report shows ${cur.raw} (${cur.mapped.toLowerCase()}); we kept the earlier ${prevBest.raw} in history. The later report decides the current state.`);
    const role = classifyTransactionId(cur.parts["transaction-id"], cur.parts["transaction-type"]).role;
    const date = cur.et.iso ? cur.et.iso.slice(0, 10) : "unknown date";
    const accObs = sorted.find((o) => o.mapped === "ACCEPTED"), firstObs = sorted[0];
    const ctx = { raw: cur.raw, date, dn: cur.et.basis.startsWith("createdAt") ? "(date as declared by the seller)" : cur.et.basis.startsWith("downloadedAt") ? "(download date as declared by the seller; no creation date was given)" : "(import date recorded by InvoiceGuard; the seller gave no report date)", why: why ?? "import scope is incomplete." };
    docs.push({
      key,
      parts: cur.parts,
      itemIds: cur.itemIds,
      state: cur.mapped,
      reasonCode: cur.reasonCode ?? null,
      unmatchedReason: cur.unmatchedReason ?? null,
      rawStatus: cur.raw,
      ownState: cur.mapped,
      correction: role ? { role, cycleKey: null, cycleState: null } : null,
      current: { importId: cur.importId, effectiveTime: cur.et.iso, timeBasis: cur.et.basis, importScope: cur.importScope },
      // Every observation keeps its OWN snapshot of the matched rows. Stages read only their own snapshot.
      history: sorted.map((o) => ({ ...snap(o), effectiveTime: o.et.iso, timeBasis: o.et.basis, current: o === last })),
      firstObserved: { ...snap(firstObs), meaning: "first report of those loaded that shows this document, as that report shows it; not the moment it happened" },
      acceptedObserved: accObs ? { ...snap(accObs), meaning: `first report of those loaded that shows ${accObs.raw} with every precondition met; it does not show when Amazon reached that state` } : null,
      evidence: { rows: cur.rows, invoiceNumber: cur.invoiceNumber, transactionId: cur.parts["transaction-id"], statusDescription: cur.statusDescription, rawStatusVerbatim: cur.raw, preconditions: cur.preconditions ?? null, duplicateRowsIgnored: cur.duplicateRows },
      anomalies,
      ctx
    });
  }
  const cycles = /* @__PURE__ */ new Map();
  for (const d of docs) if (d.correction) {
    const k = `${d.parts["marketplace-id"]}|${d.parts["order-id"]}|${d.parts["shipping-id"]}`;
    d.correction.cycleKey = k;
    if (!cycles.has(k)) cycles.set(k, []);
    cycles.get(k).push(d);
  }
  const cycleList = [];
  for (const [k, sides] of cycles) {
    const rev = sides.filter((s) => s.correction.role === "REVERSAL"), cor = sides.filter((s) => s.correction.role === "CORRECTED");
    const okSide = (a) => a.length === 1 && a[0].ownState === "ACCEPTED";
    const accepted = (okSide(rev) ? 1 : 0) + (okSide(cor) ? 1 : 0);
    const state = accepted === 2 ? "ACCEPTED" : accepted === 1 ? "PARTIALLY_ACCEPTED" : "NOT_CLOSED";
    const missing = [!rev.length && "reversal (credit note) side", !cor.length && "corrected invoice side"].filter((x) => x !== false);
    cycleList.push({ key: k, state, missing, sides: sides.map((s) => s.key) });
    for (const s of sides) {
      s.correction.cycleState = state;
      s.correction.missingSides = missing;
      if (state === "PARTIALLY_ACCEPTED" && s.ownState === "ACCEPTED") s.state = "PARTIALLY_ACCEPTED";
    }
  }
  for (const d of docs) {
    const c2 = d.ctx;
    delete d.ctx;
    d.explanation = (EXPLAIN[d.state] ?? (() => d.state))(c2);
    if (d.correction && d.state === "PARTIALLY_ACCEPTED") d.explanation += d.correction.missingSides?.length ? ` Not in the loaded files: ${d.correction.missingSides.join(", ")}.` : "";
  }
  docs.sort((a, b) => a.key.localeCompare(b.key));
  return { docs, imports: importSummaries, dateOrderConflicts, cycles: cycleList, unkeyed: unkeyedAll, warnings, headline: headline(docs, cycleList, unkeyedAll, importSummaries) };
}
function headline(docs, cycles, unkeyed, importSummaries) {
  const n = (s) => docs.filter((d) => d.state === s).length, inc = (code) => docs.filter((d) => d.state === "INCOMPLETE_SOURCE" && d.reasonCode === code).length;
  const parts = { truncatedFile: inc("TRUNCATED_FILE"), missingColumns: inc("MISSING_COLUMNS"), importNotComplete: inc("IMPORT_NOT_COMPLETE"), preconditionUnmet: inc("PRECONDITION_UNMET"), orderDateMissingOrUnreadable: inc("MISSING_OR_INVALID_ORDER_DATE"), dateFormatUnrecognized: inc("UNRECOGNIZED_DATE_FORMAT") + inc("DATE_ORDER_CONTRADICTION") + inc("MONTH_FIRST_NOT_SUPPORTED"), dateOrderUnconfirmed: n("DATE_ORDER_UNCONFIRMED"), invoiceNumberIncomplete: n("INVOICE_NUMBER_INCOMPLETE"), unmatched: n("UNMATCHED"), unknownStatus: n("UNKNOWN_STATUS"), unknownTransactionIdFormat: n("UNKNOWN_TRANSACTION_ID_FORMAT"), incompatibleStatusAndType: n("INCOMPATIBLE_STATUS_AND_TYPE") };
  const cannot = Object.values(parts).reduce((a, b) => a + b, 0);
  const openCycles = cycles.filter((c2) => c2.state !== "ACCEPTED"), openDocKeys = new Set(openCycles.flatMap((c2) => c2.sides));
  const EXC = ["REJECTED", "SELLER_UPLOAD_REQUIRED", "INCOMPLETE_SOURCE", "UNMATCHED", "UNKNOWN_STATUS", "UNKNOWN_TRANSACTION_ID_FORMAT", "INCOMPATIBLE_STATUS_AND_TYPE", "INVOICE_NUMBER_INCOMPLETE", "DATE_ORDER_UNCONFIRMED"];
  const exceptions = docs.filter((d) => EXC.includes(d.state) || openDocKeys.has(d.key)).length;
  const counts = {
    documents: docs.length,
    accepted: n("ACCEPTED"),
    partiallyAccepted: n("PARTIALLY_ACCEPTED"),
    processing: n("PROCESSING"),
    pending: n("PENDING"),
    rejected: n("REJECTED"),
    sellerUploadRequired: n("SELLER_UPLOAD_REQUIRED"),
    createdByAmazon: n("CREATED_BY_AMAZON"),
    correctionCyclesNotClosed: openCycles.length,
    cannotDetermine: cannot,
    cannotDetermineParts: parts,
    rowsWithoutKey: unkeyed.length
  };
  const sentence = `Out of ${counts.documents} document(s) in the loaded files: ${exceptions} document(s) with an exception (one document can be in more than one line below): ${counts.rejected} rejected by Amazon, ${counts.sellerUploadRequired} where the seller must upload the invoice and nothing is uploaded (NoTaxCalculated), ${counts.correctionCyclesNotClosed} correction(s) not closed on both sides, ${cannot} we cannot determine (${parts.truncatedFile} from a partly read file, ${parts.missingColumns} from a file with missing columns, ${parts.importNotComplete} from another incomplete import, ${parts.preconditionUnmet} with an unmet check, ${parts.orderDateMissingOrUnreadable} with a missing or unreadable order date, ${parts.dateFormatUnrecognized} with dates in a format we do not recognise, that look month-first or that contradict each other, ${parts.dateOrderUnconfirmed} waiting for the seller to confirm the date format, ${parts.invoiceNumberIncomplete} with an invoice number blank on some rows, ${parts.unmatched} unmatched, ${parts.unknownStatus} unknown status, ${parts.unknownTransactionIdFormat} unknown correction id format, ${parts.incompatibleStatusAndType} status that does not fit the transaction type). ${counts.processing + counts.pending} in progress (pending or processing), ${counts.accepted} observed as accepted, ${counts.createdByAmazon} created by Amazon (nothing to upload). Separately, ${counts.rowsWithoutKey} row(s) have a blank key field and are not counted as documents. State of the files as loaded; it says nothing about files that were not loaded.`;
  return { ...counts, exceptions, accountingComparison: "not available: needs the seller invoice export (Issued is not visible in the Amazon files)", sentence, anyCompleteImport: importSummaries.some((i) => i.scope === "COMPLETE_SCOPE") };
}

// src/loop/ledger.js
init_buffer_shim();
var LEDGER_MAX_ROWS = 2e4;
var PARSER_VERSION = "ledger-1";
var FIELDS = ["number", "kind", "series", "issueDate", "operationDate", "currency", "gross", "net", "vat", "issuerTaxId", "buyerTaxId", "orderRef", "channel", "originalRef"];
var REQUIRED = ["number", "issueDate", "currency"];
var norm = (h) => String(h ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
var DICT = {
  number: ["invoice number", "invoice no", "invoice nr", "invoice id", "document number", "document no", "doc number", "numero de factura", "numero factura", "n factura", "num factura", "numero de documento", "rechnungsnummer", "rechnungsnr", "dokumentnummer", "numero de facture", "numero fattura", "numero documento", "number"],
  kind: ["document type", "doc type", "type", "document kind", "kind", "tipo", "tipo de documento", "tipo documento", "dokumenttyp", "belegart", "type de document", "tipo di documento"],
  series: ["series", "serie", "invoice series", "serie de factura"],
  issueDate: ["invoice date", "issue date", "date issued", "date", "fecha", "fecha de factura", "fecha factura", "fecha de emision", "fecha emision", "rechnungsdatum", "datum", "date de facture", "data fattura"],
  operationDate: ["order date", "operation date", "sale date", "sales date", "fecha de operacion", "fecha operacion", "fecha de venta", "fecha pedido", "bestelldatum", "date de commande", "data ordine"],
  currency: ["currency", "moneda", "divisa", "wahrung", "whrung", "devise", "valuta"],
  gross: ["gross", "gross amount", "total", "total amount", "total gross", "importe total", "total factura", "brutto", "bruttobetrag", "total ttc", "totale"],
  net: ["net", "net amount", "total net", "base imponible", "importe neto", "netto", "nettobetrag", "total ht", "imponibile"],
  vat: ["vat", "vat amount", "tax", "tax amount", "iva", "cuota iva", "importe iva", "mwst", "umsatzsteuer", "tva", "imposta"],
  issuerTaxId: ["issuer vat", "issuer tax id", "seller vat", "seller tax id", "nif emisor", "nif del emisor", "ust id verkaufer", "ust idnr aussteller"],
  buyerTaxId: ["buyer vat", "buyer tax id", "customer vat", "customer tax id", "vat number", "nif cliente", "nif comprador", "cif cliente", "ust idnr kaufer", "ust idnr kunde"],
  orderRef: ["amazon order id", "order id", "amazon order", "order reference", "order ref", "pedido amazon", "id de pedido", "referencia pedido", "referencia de pedido", "bestellnummer", "numero de pedido", "numero de commande"],
  channel: ["channel", "sales channel", "canal", "canal de venta", "marketplace", "verkaufskanal", "source", "origen"],
  originalRef: ["original invoice", "original document", "rectifies", "factura rectificada", "factura original", "documento original"]
};
var KIND_WORDS = { invoice: ["invoice", "factura", "rechnung", "facture", "fattura", "factura emitida"], credit_note: ["credit note", "creditnote", "credit memo", "abono", "nota de credito", "factura de abono", "factura rectificativa", "rectificativa", "gutschrift", "avoir", "nota di credito", "nota credito"] };
var kindOf = (v) => {
  const n = norm(v);
  for (const [k, ws] of Object.entries(KIND_WORDS)) if (ws.includes(n)) return k;
  return null;
};
function splitLine(line, d) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c2 = line[i];
    if (q) {
      if (c2 === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c2;
    } else if (c2 === '"' && cur === "") q = true;
    else if (c2 === d) {
      out.push(cur);
      cur = "";
    } else cur += c2;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
function readDelimited(text, delimiter = null) {
  text = String(text ?? "").replace(/^\uFEFF/, "");
  const all = text.split(/\r?\n/), isBlank = (l) => !l.trim();
  let lo = 0, hi = all.length;
  while (lo < hi && isBlank(all[lo])) lo++;
  while (hi > lo && isBlank(all[hi - 1])) hi--;
  const lines = all.slice(lo, hi);
  if (lines.length < 2) return { ok: false, error: "The file has no header and data rows." };
  const count = (c2) => splitLine(lines[0], c2).length;
  const d = delimiter ?? ["	", ";", ","].map((c2) => [c2, count(c2)]).sort((a, b) => b[1] - a[1] || "	;,".indexOf(a[0]) - "	;,".indexOf(b[0]))[0][0];
  const head = splitLine(lines[0], d);
  if (head.length < 2) return { ok: false, error: "The file does not look like a table with columns." };
  const body = lines.slice(1), kept = body.slice(0, LEDGER_MAX_ROWS);
  let blankLines = 0, raggedRows = 0;
  const rows = [];
  kept.forEach((l, i) => {
    if (isBlank(l)) {
      blankLines++;
      return;
    }
    const cells = splitLine(l, d);
    if (cells.length !== head.length) raggedRows++;
    rows.push({ row: lo + i + 2, cells });
  });
  return { ok: true, delimiter: d, head, rows, truncated: body.length > LEDGER_MAX_ROWS, blankLines, raggedRows };
}
var validDay2 = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
var iso = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function dateReadings(v) {
  const s = String(v ?? "").trim(), r = {};
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)) && validDay2(+m[1], +m[2], +m[3])) r.ISO = iso(+m[1], +m[2], +m[3]);
  if (m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s)) {
    if (validDay2(+m[3], +m[2], +m[1])) r.DMY = iso(+m[3], +m[2], +m[1]);
    if (validDay2(+m[3], +m[1], +m[2])) r.MDY = iso(+m[3], +m[1], +m[2]);
  }
  return r;
}
function readDate(v, order) {
  const r = dateReadings(v);
  return r.ISO ?? (order === "DMY" ? r.DMY : order === "MDY" ? r.MDY : void 0) ?? null;
}
function readMoney(v, decimal, thousands = "") {
  let s = String(v ?? "").trim();
  if (s === "") return null;
  const dec2 = decimal === "," ? "," : ".", esc = (c2) => c2.replace(/[.\-\\^$*+?()[\]{}|]/g, "\\$&");
  const grp = thousands ? `(?:\\d{1,3}(?:${esc(thousands)}\\d{3})+|\\d+)` : "\\d+";
  const m = new RegExp(`^(-?)(${grp})(?:${esc(dec2)}(\\d{1,2}))?$`).exec(s);
  if (!m) return NaN;
  const whole = m[2].split(thousands || "\0").join(""), frac = (m[3] ?? "").padEnd(2, "0");
  return (m[1] ? -1 : 1) * (parseInt(whole, 10) * 100 + parseInt(frac || "0", 10));
}
function detectLedgerMapping(text) {
  const t = readDelimited(text);
  if (!t.ok) return { ok: false, error: t.error };
  const heads = t.head.map(norm), cols = (i) => t.rows.map((r) => r.cells[i] ?? "").filter((x) => x !== ""), fields = {}, used = /* @__PURE__ */ new Map();
  for (const f of FIELDS) {
    const cand = heads.map((h, i2) => DICT[f].includes(h) ? i2 : -1).filter((i2) => i2 >= 0);
    if (cand.length === 0) {
      fields[f] = { status: REQUIRED.includes(f) || f === "kind" ? "MISSING" : "ABSENT", header: null, candidates: [] };
      continue;
    }
    if (cand.length > 1) {
      fields[f] = { status: "AMBIGUOUS", header: null, candidates: cand.map((i2) => t.head[i2]), reason: "More than one column fits this field. Choose one." };
      continue;
    }
    const i = cand[0], vals = cols(i);
    let bad = 0, example = null, reason = null;
    const fail = (v, why) => {
      bad++;
      if (example === null) {
        example = v;
        reason = why;
      }
    };
    if (f === "issueDate" || f === "operationDate") vals.forEach((v) => {
      if (!Object.keys(dateReadings(v)).length) fail(v, "not a date we can read");
    });
    else if (f === "currency") vals.forEach((v) => {
      if (!/^[A-Za-z]{3}$/.test(v)) fail(v, "not a three-letter currency code");
    });
    else if (f === "orderRef") vals.forEach((v) => {
      if (!/^\d{3}-\d{7}-\d{7}$/.test(v)) fail(v, "not an Amazon order id (3-7-7 digits)");
    });
    else if (f === "kind") vals.forEach((v) => {
      if (!kindOf(v)) fail(v, "a document type we do not recognise");
    });
    else if (f === "number") {
      if (!vals.length) fail("", "no document numbers at all");
    }
    fields[f] = bad ? { status: "CONTENT_FAILED", header: t.head[i], candidates: [t.head[i]], reason: `${bad} cell(s) fail, for example ${JSON.stringify(example)}: ${reason}.` } : { status: "DETECTED", header: t.head[i], candidates: [t.head[i]] };
    if (!bad) used.set(i, f);
  }
  const unknownColumns = t.head.filter((h, i) => !used.has(i));
  const dateCols = ["issueDate", "operationDate"].map((f) => fields[f].header).filter(Boolean).map((h) => t.head.indexOf(h));
  let dmy = 0, mdy = 0, isoOnly = 0, amb = 0, n = 0;
  for (const i of dateCols) for (const v of cols(i)) {
    n++;
    const r = dateReadings(v);
    if (r.ISO) {
      isoOnly++;
      continue;
    }
    if (r.DMY && !r.MDY) dmy++;
    else if (r.MDY && !r.DMY) mdy++;
    else if (r.DMY && r.MDY) amb++;
  }
  const dateOrder = !n ? { status: "NONE" } : dmy && mdy ? { status: "CONTRADICTION", reason: "Some dates can only be day first and others only month first." } : isoOnly === n ? { status: "PROVEN", proposed: "ISO" } : dmy ? { status: "PROVEN", proposed: "DMY" } : mdy ? { status: "PROVEN", proposed: "MDY" } : { status: "AMBIGUOUS", reason: "Every date fits both day-first and month-first. Say which one this file uses." };
  const moneyCols = ["gross", "net", "vat"].map((f) => fields[f].header).filter(Boolean).map((h) => t.head.indexOf(h));
  let comma = 0, point = 0, both = 0, mn = 0;
  for (const i of moneyCols) for (const v of cols(i)) {
    mn++;
    const c2 = /,\d{1,2}$/.test(v), p = /\.\d{1,2}$/.test(v), thC = /,\d{3}/.test(v), thP = /\.\d{3}($|[^\d])/.test(v);
    if (c2 && !p && !thC) comma++;
    else if (p && !c2 && !thP) point++;
    else if (/^-?\d+$/.test(v)) {
    } else both++;
  }
  const decimal = !mn ? { status: "NONE" } : comma && point ? { status: "CONTRADICTION" } : comma ? { status: "PROPOSED", proposed: "," } : point ? { status: "PROPOSED", proposed: "." } : { status: both ? "AMBIGUOUS" : "PROPOSED", proposed: "." };
  const kindColumn = fields.kind.status === "DETECTED";
  const problems = [];
  for (const f of [...REQUIRED, ...kindColumn ? [] : []]) if (fields[f].status !== "DETECTED") problems.push({ field: f, status: fields[f].status, reason: fields[f].reason ?? `No column found for "${f}".` });
  if (!kindColumn && fields.kind.status !== "MISSING") problems.push({ field: "kind", status: fields.kind.status, reason: fields.kind.reason });
  if (dateOrder.status === "CONTRADICTION") problems.push({ field: "dates", status: "CONTRADICTION", reason: dateOrder.reason });
  if (decimal.status === "CONTRADICTION") problems.push({ field: "amounts", status: "CONTRADICTION", reason: "Some amounts use a decimal comma and others a decimal point." });
  return {
    ok: true,
    delimiter: t.delimiter,
    headers: t.head,
    rowCount: t.rows.length,
    truncated: t.truncated,
    blankLines: t.blankLines,
    raggedRows: t.raggedRows,
    fields,
    unknownColumns,
    dateOrder,
    decimal,
    needsKindDeclaration: !kindColumn,
    problems,
    proposedProfile: { delimiter: t.delimiter, columns: Object.fromEntries(FIELDS.filter((f) => fields[f].status === "DETECTED").map((f) => [f, fields[f].header])), constantKind: null, dateOrder: dateOrder.proposed ?? null, decimal: decimal.proposed ?? null, thousands: "", unknownColumnsAcknowledged: false, confirmed: false }
  };
}
function profileProblems(profile, head) {
  const p = [];
  if (!profile || typeof profile !== "object") return ["No mapping profile."];
  if (profile.confirmed !== true) p.push("The seller has not confirmed the column mapping.");
  const cols = profile.columns ?? {};
  for (const f of REQUIRED) if (!cols[f]) p.push(`No column is mapped for "${f}".`);
  if (!cols.kind && !["invoice", "credit_note"].includes(profile.constantKind)) p.push("No document type column is mapped and the seller has not declared what every row is.");
  for (const [f, h] of Object.entries(cols)) {
    if (!FIELDS.includes(f)) p.push(`Unknown field "${f}".`);
    else if (head && !head.includes(h)) p.push(`The mapped column "${h}" is not in this file.`);
  }
  if (new Set(Object.values(cols)).size !== Object.values(cols).length) p.push("One column is mapped to two fields.");
  if (!["ISO", "DMY", "MDY"].includes(profile.dateOrder)) p.push("The date order is not declared.");
  if ((cols.gross || cols.net || cols.vat) && ![",", "."].includes(profile.decimal)) p.push("The decimal separator is not declared.");
  if (head) {
    const mapped = new Set(Object.values(cols)), unk = head.filter((h) => !mapped.has(h));
    if (unk.length && profile.unknownColumnsAcknowledged !== true) p.push(`Columns not mapped and not acknowledged: ${unk.join(", ")}.`);
  }
  return p;
}
function readLedger(text, profile, { importId = null, amazonScope = { mode: "UNKNOWN" }, sourceSystem = "" } = {}) {
  const t = readDelimited(text, profile?.delimiter ?? null);
  if (!t.ok) return { ok: false, error: t.error, documents: [], rejected: [], defects: [t.error], parserVersion: PARSER_VERSION };
  const probs = profileProblems(profile, t.head);
  const base = { parserVersion: PARSER_VERSION, rowCount: t.rows.length, truncated: t.truncated, blankLines: t.blankLines, raggedRows: t.raggedRows, head: t.head };
  if (probs.length) return { ok: false, ...base, error: probs.join(" "), documents: [], rejected: [], defects: probs };
  const ix = Object.fromEntries(Object.entries(profile.columns).map(([f, h]) => [f, t.head.indexOf(h)])), documents = [], rejected = [];
  const chan = new Set((amazonScope.channelValues ?? []).map(norm));
  for (const { row, cells } of t.rows) {
    const reasons = [], g = (f) => ix[f] === void 0 ? "" : cells[ix[f]] ?? "";
    if (cells.length !== t.head.length) {
      rejected.push({ row, reasons: ["WRONG_CELL_COUNT: the row has a different number of columns from the header"], cells });
      continue;
    }
    const number = g("number");
    if (!number) reasons.push("BLANK_NUMBER: the document number is empty");
    const kind = ix.kind !== void 0 ? kindOf(g("kind")) : profile.constantKind;
    if (!kind) reasons.push(`UNREADABLE_KIND: ${JSON.stringify(g("kind"))} is not a document type we recognise`);
    const issueDate = readDate(g("issueDate"), profile.dateOrder);
    if (!issueDate) reasons.push(`BAD_ISSUE_DATE: ${JSON.stringify(g("issueDate"))} cannot be read as a date in the declared order`);
    let operationDate = null;
    if (ix.operationDate !== void 0 && g("operationDate") !== "") {
      operationDate = readDate(g("operationDate"), profile.dateOrder);
      if (!operationDate) reasons.push(`BAD_OPERATION_DATE: ${JSON.stringify(g("operationDate"))} cannot be read as a date in the declared order`);
    }
    const currency = g("currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) reasons.push(`BAD_CURRENCY: ${JSON.stringify(g("currency"))}`);
    const money = {};
    for (const f of ["gross", "net", "vat"]) if (ix[f] !== void 0) {
      const v = readMoney(g(f), profile.decimal, profile.thousands ?? "");
      if (Number.isNaN(v)) reasons.push(`BAD_AMOUNT_${f.toUpperCase()}: ${JSON.stringify(g(f))} cannot be read exactly with decimal "${profile.decimal}"`);
      else money[f] = v;
    }
    const orderRef = g("orderRef");
    if (orderRef && !/^\d{3}-\d{7}-\d{7}$/.test(orderRef)) reasons.push(`BAD_ORDER_REF: ${JSON.stringify(orderRef)}`);
    if (reasons.length) {
      rejected.push({ row, reasons, cells });
      continue;
    }
    const channel = ix.channel !== void 0 ? g("channel") : null;
    const isAmazon = amazonScope.mode === "ALL" ? true : amazonScope.mode === "CHANNEL" ? channel !== null && chan.has(norm(channel)) : null;
    documents.push({
      importId,
      row,
      number,
      kind,
      series: g("series"),
      issueDate,
      operationDate,
      currency,
      gross: money.gross ?? null,
      net: money.net ?? null,
      vat: money.vat ?? null,
      issuerTaxId: g("issuerTaxId"),
      buyerTaxId: g("buyerTaxId"),
      orderRef: orderRef || null,
      channel,
      originalRef: g("originalRef") || null,
      isAmazon,
      identity: ["led", sourceSystem, kind, g("series"), number, g("issuerTaxId")].join("|"),
      raw: cells
    });
  }
  const defects = [];
  if (rejected.length) defects.push(`${rejected.length} row(s) could not be read exactly and were rejected`);
  if (t.truncated) defects.push("only the first part of the file was read");
  if (t.blankLines) defects.push(`${t.blankLines} blank line(s) inside the data`);
  if (t.raggedRows) defects.push(`${t.raggedRows} row(s) with the wrong number of columns`);
  return { ok: true, ...base, documents, rejected, defects };
}

// src/loop/sha256.js
init_buffer_shim();
var K = new Uint32Array([1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298]);
function sha256(str) {
  const msg = new TextEncoder().encode(String(str)), l = msg.length, n = (l + 8 >> 6) + 1 << 6, buf = new Uint8Array(n);
  buf.set(msg);
  buf[l] = 128;
  const dv = new DataView(buf.buffer);
  dv.setUint32(n - 8, Math.floor(l * 8 / 4294967296));
  dv.setUint32(n - 4, l * 8 >>> 0);
  const H = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225]), w = new Uint32Array(64);
  const rr = (x, c2) => x >>> c2 | x << 32 - c2;
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a2 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ w[i - 15] >>> 3, b2 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + a2 + w[i - 7] + b2 >>> 0;
    }
    let [a, b, c2, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = h + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + (e & f ^ ~e & g) + K[i] + w[i] >>> 0, t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + (a & b ^ a & c2 ^ b & c2) >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c2;
      c2 = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c2;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

// src/loop/events.js
init_buffer_shim();
var EVENT_TYPES = ["ACTION_STARTED", "RESOLUTION_DECLARED", "LINK_DECISION", "DIFFERENCE_EXPLAINED"];
var DECLARATION_TYPES = Object.freeze(["RESOLUTION_DECLARED", "DIFFERENCE_EXPLAINED"]);
var DECLARATION_ALLOWED = Object.freeze({
  UNMATCHED_DOCUMENT: { kinds: ["NOT_AN_AMAZON_SALE"], subtypes: ["NO_CANDIDATE"] },
  BOOKS_GAP: { kinds: ["RESOLUTION_DECLARED"], subtypes: null },
  DATA_MISMATCH: { kinds: ["DIFFERENCE_EXPLAINED"], subtypes: null }
});
var NO_DECLARATION = Object.freeze(["INVOICE_AMAZON_STATE", "SOURCE_INCOMPLETE", "DUPLICATE_DOCUMENT", "CREDIT_NOTE_AMAZON_STATE", "CORRECTION_PAIR_OPEN"]);
var blank2 = (v) => !String(v ?? "").trim();
function eventShapeProblem(e) {
  if (!e || !EVENT_TYPES.includes(e.type)) return "Unknown event type.";
  if (blank2(e.author)) return "An event needs an author (any name or role the seller chooses).";
  if (blank2(e.reasoning)) return "An event needs the seller's reasoning, in words.";
  if (Number.isNaN(Date.parse(e.createdAt))) return "An event needs a time.";
  if (e.type === "LINK_DECISION") {
    if (blank2(e.ledgerKey) || blank2(e.amazonId) || !["CONFIRM", "REJECT"].includes(e.decision)) return "A link decision names the accounting document, the Amazon transaction and CONFIRM or REJECT.";
  } else if (blank2(e.issueKey)) return "An event names the problem it is about.";
  if (e.type === "RESOLUTION_DECLARED" && blank2(e.kind)) return "A declared resolution needs its kind.";
  return null;
}
function declarationProblem(e, family, subtype) {
  if (NO_DECLARATION.includes(family)) return "Amazon's own state and the state of a file cannot be declared resolved. Only a newer file can change them.";
  const rule = DECLARATION_ALLOWED[family];
  if (!rule) return "This kind of problem does not accept a declaration.";
  const kind = e.type === "DIFFERENCE_EXPLAINED" ? "DIFFERENCE_EXPLAINED" : e.kind;
  if (kind === "DIFFERENCE_EXPLAINED" && e.type !== "DIFFERENCE_EXPLAINED") return "A difference is explained with its own kind of note, not with a general resolution.";
  if (!rule.kinds.includes(kind)) return `This kind of problem accepts only: ${rule.kinds.join(", ")}.`;
  if (rule.subtypes && !rule.subtypes.includes(subtype)) return `This declaration applies only to problems of kind: ${rule.subtypes.join(", ")}.`;
  return null;
}

// src/loop/cards.js
init_buffer_shim();
var STATE_LABEL = { OPEN: "Needs a human reading", ACTION_REQUIRED: "Action required", AWAITING_NEW_EVIDENCE: "Waiting for new evidence", VERIFIED_CLOSED: "Closed, with evidence", MANUALLY_REPORTED_RESOLUTION: "Reported resolved by you, not confirmed by the files" };
var mkt = (s) => s?.marketplace ?? "the declared marketplace";
function buildCard(i) {
  const s = i.subject ?? {}, e = i.finding?.evidence ?? {}, t = i.subtype;
  const c2 = { title: "", what: "", why: "", proof: [], action: "", closesWhen: "", stateLabel: STATE_LABEL[i.state] ?? i.state, stateNote: null, history: i.history };
  c2.proof = (e.sources ?? []).map((src) => ({ file: src.fileName ?? src.importId, role: src.role === "amazon" ? "Amazon VAT invoice report" : "Your accounting export", rows: src.rows }));
  if (i.family === "INVOICE_AMAZON_STATE") {
    const ord = `order ${s.orderId}, shipment ${s.shippingId}`;
    if (t === "REJECTED") {
      c2.title = `Amazon rejected the invoice for ${ord}`;
      c2.what = `The report shows the status ${e.statusAsShown}${e.amazonDescription ? ` with Amazon's description: "${e.amazonDescription}"` : ""}.`;
      c2.why = "The status comes straight from the Amazon report row shown below.";
      c2.action = "Correct the problem Amazon names in its description, then upload the invoice again. Amazon says the seller must upload the document again after a rejection.";
    } else {
      c2.title = `Amazon is waiting for an invoice for ${ord}`;
      c2.what = `The report shows the status ${e.statusAsShown}${e.invoiceNumber ? "" : " and no invoice number"}.`;
      c2.why = "The status comes straight from the Amazon report row shown below.";
      c2.action = "Upload the invoice for this transaction to Amazon. If you have not created it yet, create it in your accounting system first.";
    }
    c2.closesWhen = "A newer Amazon report, loaded here, shows this transaction as InvoiceUploaded and all conditions of the evidence contract are met. Telling us you uploaded it does not close this.";
    if (i.awaiting === "AMAZON_PROCESSING") c2.stateNote = "The latest report shows this as processing. Amazon says no new upload is needed while it processes. Load a newer report to see the result.";
  } else if (i.family === "BOOKS_GAP") {
    const ord = `order ${s.orderId}, shipment ${s.shippingId}`;
    if (t === "NUMBER_AT_AMAZON_NOT_IN_BOOKS") {
      c2.title = `Amazon shows invoice ${e.invoiceNumberAtAmazon} for ${ord}, but your accounting export does not contain it`;
      c2.what = `Amazon's report shows the document number ${e.invoiceNumberAtAmazon} (state ${e.amazonState}). No document with that number is in the accounting export described below.`;
      c2.action = "Check your accounting system for this document. If it exists there, export again so that it is included. If it does not exist there, tell your accountant: Amazon holds a document with this number that your books do not.";
    } else {
      c2.title = `No invoice found in your books for ${ord}`;
      c2.what = `Amazon's report shows no invoice number for this transaction (state ${e.amazonState}) and your accounting export has no document for it.`;
      c2.action = "Create the invoice in your accounting system, then upload it to Amazon. If it already exists in your books, make sure its Amazon order id is exported.";
    }
    c2.why = e.coverage ? `The accounting export "${e.coverage.fileName ?? e.coverage.id}" is declared as a complete export of ${e.coverage.sourceSystem ?? "your system"} Amazon sales for ${e.coverage.period}. If this invoice was issued after that period, load a newer export.` : "See the declared period of your accounting export.";
    c2.closesWhen = "A newer accounting export, loaded here, contains a document whose number equals the one Amazon shows, and it is the only one. A statement from you alone does not close this.";
    if (e.declaredLink) c2.stateNote = `You declared this document as the match (${e.declaredLink.document}). No file confirms it.`;
    if (i.state === "OPEN" && i.finding?.note) c2.stateNote = i.finding.note;
  } else if (i.family === "UNMATCHED_DOCUMENT") {
    const d = e.document ?? {};
    const lead = `accounting document ${s.number ?? ""}`;
    if (t === "PROPOSED_LINK_UNCONFIRMED") {
      c2.title = `Is ${lead} the one Amazon shows for order ${s.orderRef}?`;
      c2.what = `Your document names Amazon order ${s.orderRef}, and exactly one Amazon transaction of that order has no invoice number yet. That is a candidate, not a match: an order id alone does not confirm that two documents are the same.`;
      c2.why = "The accounting export carries the Amazon order id. The Amazon report has no invoice number for the candidate yet, so the numbers cannot be compared.";
      c2.action = "Look at both rows below. If they are the same sale, confirm the link. If not, reject it.";
      c2.closesWhen = "A newer Amazon report shows an invoice number equal to this document's number. Your confirmation only records your decision; it does not close this.";
    } else if (t === "MULTIPLE_CANDIDATES") {
      c2.title = `Cannot tell which document ${s.number ?? ""} belongs to`;
      c2.what = `${e.why ?? "More than one candidate exists"}.`;
      c2.why = "We link documents only when the match is unique. We do not pick one.";
      c2.action = "Check which transaction this document belongs to and correct the order id or document number in your accounting export, then load it again.";
      c2.closesWhen = "A newer export in which the document is unique and its number equals the number Amazon shows.";
    } else {
      c2.title = `${lead.charAt(0).toUpperCase() + lead.slice(1)} is not visible in Amazon`;
      c2.what = `Your accounting export has this document (issued ${d.issueDate}, operation date ${d.operationDate}). A complete all-statuses Amazon report for ${mkt(s)} covering that date has no transaction that matches it.`;
      c2.why = e.coverage ? `Checked against the Amazon report "${e.coverage.fileName ?? e.coverage.id}" covering ${e.coverage.range}.` : "";
      c2.action = "If this was an Amazon sale, ask your accountant why Amazon has no matching transaction (wrong marketplace, order id or date). If it was not an Amazon sale, you can declare that, with your reason.";
      c2.closesWhen = "A newer Amazon report that shows a transaction with this document number. Declaring it is not an Amazon sale records your statement and does not change what the files show.";
    }
  } else if (i.family === "DATA_MISMATCH") {
    const ds = e.differences ?? [], nc = e.notCompared ?? [];
    c2.title = `Amazon and your books show different values for document ${s.number ?? ""} (order ${s.orderId})`;
    if (t === "CANNOT_CONFIRM") {
      c2.title = `Cannot confirm that the difference for document ${s.number ?? ""} is gone`;
      c2.what = "The difference is no longer shown, but a field that differed can no longer be compared.";
      c2.why = nc.map((x) => `${x.field}: ${x.reason}`).join("; ") + ".";
      c2.action = "Load files that state that field exactly on both sides.";
    } else {
      c2.what = ds.map((d) => `${d.label}: Amazon shows ${d.amazon}, your accounting export shows ${d.books}${d.difference ? ` (difference ${d.difference})` : ""}`).join(". ") + ".";
      c2.why = "Both values are read exactly from the rows shown below. No tolerance is applied: any difference, including one cent, is shown. " + (nc.length ? "Not compared: " + nc.map((x) => `${x.field} (${x.reason})`).join("; ") + "." : "");
      c2.action = "Find out which side is right. This tool does not change your accounting documents or anything at Amazon. If your document needs correcting, do it in your accounting system the way your accountant advises, then export again and load the new file.";
    }
    c2.closesWhen = "A newer file, loaded here, shows the same pair with the compared values agreeing. Saying the difference is explained records your statement and does not change what the files show.";
  } else if (i.family === "DUPLICATE_DOCUMENT") {
    c2.title = `Document ${s.number ?? ""} appears more than once in one accounting file`;
    if (e.documentLevel === "LINE" && t === "SAME_NUMBER_DIFFERENT_CONTENT") {
      const fs = e.disagreeingFields ?? [];
      c2.title = `The rows of document ${s.number ?? ""} disagree on data that belongs to the whole document`;
      c2.what = `You declared that each row of this export is one line item of a document. Rows ${(e.rowNumbers ?? []).join(", ")} share the document number ${s.number ?? ""}, but they do not agree on ` + (fs.length ? fs.map((f) => `the ${f.label} (${f.values.map((v) => `${v.row}: ${v.value ?? "empty"}`).join("; ")})`).join("; ") : "a document-level field") + ".";
      c2.why = "Line items may differ from each other, but the issue date, operation date, currency, order reference and buyer tax id are supposed to be the same on every line of one document. The rows shown here mark where they differ. We do not pick one of the rows.";
      c2.action = "Check these rows in your accounting system and make the document-level data the same on every line of the document, if that is what the document says. Nothing in this message means that a row should be deleted.";
      c2.closesWhen = "A newer complete accounting export of the same scope in which the document-level data agrees across the lines.";
      return c2;
    }
    if (t === "SUSPECTED_DUPLICATE") {
      c2.title = `Document ${s.number ?? ""} is on several rows: cannot tell if it is a duplicate`;
      c2.what = `Rows ${(e.rowNumbers ?? []).join(", ")} carry the same document number.`;
      c2.why = "The file does not say what one row is. If each row is one line of the document, the repetition is normal; if each row is a whole document, it is a duplicate.";
      c2.action = "Load the file again and state what one row is: a whole document or one line item of a document. Do not remove rows from your accounting system because of this message.";
      c2.closesWhen = "A complete export of the same scope that states what one row is. If one row is one document, a repeated number then becomes a duplicate; if one row is one line item, the repetition is expected.";
      return c2;
    }
    c2.what = t === "SAME_NUMBER_DIFFERENT_CONTENT" ? `Rows ${(e.rowNumbers ?? []).join(", ")} carry the same document identity with different content.` : `Rows ${(e.rowNumbers ?? []).join(", ")} are identical copies of the same document.`;
    c2.why = "A document identity can hold one document. We do not pick one of the rows.";
    c2.action = "You declared that one row of this export is a whole document, so the same document number on several rows is a problem in the export. Check the rows shown below in your accounting system. Do not delete anything that is correct; if a row is a line item of a document, load the file again and declare that one row is one line item.";
    c2.closesWhen = "A newer accounting export, loaded here, in which this document appears once. A later export of the same document is a re-export, not a duplicate.";
  } else if (i.family === "SOURCE_INCOMPLETE") {
    c2.title = `A file is not complete: ${s.source ?? "import"} ${s.fileName ?? ""}`.trim();
    c2.what = `This file cannot be used as a complete source: ${(e.defects ?? []).join("; ")}.`;
    c2.why = `Scope of the file: ${s.descriptor}.`;
    c2.action = "Fix what is listed (download or export the file again, or declare what is missing) and load it again.";
    c2.closesWhen = "A newer import for the same scope that is complete. A declaration alone cannot close this.";
  }
  if (i.state === "AWAITING_NEW_EVIDENCE" && i.awaiting === "SELLER_REPORTED_ACTION") c2.stateNote = "You told us you started the action. That is recorded. It proves nothing about Amazon or your books until a newer file shows it.";
  if (i.state === "MANUALLY_REPORTED_RESOLUTION" && i.declaration) c2.stateNote = `${i.declaration.author} reported this resolved on ${i.declaration.createdAt}: "${i.declaration.reasoning}". No file confirms it.`;
  if (i.state === "VERIFIED_CLOSED") c2.stateNote = `Closed by evidence: ${i.closure?.why ?? ""}`;
  if (i.reopened) c2.stateNote = (c2.stateNote ? c2.stateNote + " " : "") + "This problem was closed by evidence earlier and a newer file shows it again. Both pieces of evidence are kept in the history.";
  if (i.lapsedDeclarations?.length) c2.stateNote = (c2.stateNote ? c2.stateNote + " " : "") + "An earlier declaration no longer applies because the evidence it was based on changed.";
  return c2;
}

// src/loop/project.js
var LOOP_VERSION = "loop-1.0";
var KEY_VERSION = "k1";
var FAMILIES = Object.freeze(["SOURCE_INCOMPLETE", "UNMATCHED_DOCUMENT", "INVOICE_AMAZON_STATE", "BOOKS_GAP", "DATA_MISMATCH", "DUPLICATE_DOCUMENT"]);
var NOT_CHECKED_IN_THIS_VERSION = Object.freeze(["credit notes and rectificativas", "correction pairs", "the invoice total, net and VAT amounts, document dates, line items and tax rates of a linked pair (the Amazon report states the item price, not the invoice total)", "a document that appears in two different files (a re-export is not a duplicate)"]);
var ms2 = (v) => {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
var day = (v) => {
  const t = ms2(v);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
};
var uniq2 = (a) => [...new Set(a)];
var DEFECT_CODES_EXCLUDED = ["NOT_ALL_STATUSES"];
var issueKey = (sellerProfileId, family, identity) => sha256([KEY_VERSION, sellerProfileId, family, identity].join("\n"));
var isLedger = (i) => i.kind === "ledger";
var createdMs = (i) => isLedger(i) ? ms2(i.declared?.exportedAt) : ms2(i.declared?.createdAt);
var fullScope = (i) => isLedger(i) ? i.declared?.complete === true : i.declared?.options === "ALL";
var loopTime = (i) => {
  const d = i.declared ?? {};
  return (isLedger(i) ? ms2(d.exportedAt) : ms2(d.createdAt) ?? ms2(d.downloadedAt)) ?? ms2(i.importedAt) ?? 0;
};
var orderImports = (imports) => [...imports].sort((a, b) => loopTime(a) - loopTime(b) || String(a.importedAt).localeCompare(String(b.importedAt)) || String(a.id).localeCompare(String(b.id)));
var descriptor = (i) => {
  const d = i.declared ?? {};
  return isLedger(i) ? ["ledger", d.sourceSystem, d.marketplace, `${d.periodFrom}..${d.periodTo}`, [...d.documentKinds ?? []].sort().join("+"), `scope=${d.amazonScope?.mode ?? "UNKNOWN"}:${[...new Set((d.amazonScope?.channelValues ?? []).map((v) => String(v).trim().toLowerCase()))].sort().join(",")}`].join("|") : ["vidr", "amazon-vidr", d.marketplace, `${d.rangeFrom}..${d.rangeTo}`, "all-kinds"].join("|");
};
var amazonId = (d) => ["amz", d.parts["marketplace-id"], d.parts["transaction-type"], d.parts["transaction-id"], d.parts["order-id"], d.parts["shipping-id"], "INVOICE"].join("|");
var ledgerKey = (l) => `${l.marketplace}|${l.identity}`;
function evaluate(prefix, events, ctx) {
  const vidr = prefix.filter((i) => !isLedger(i)), led = prefix.filter(isLedger);
  const rec = vidr.length ? reconcile(vidr) : { docs: [], imports: [] };
  const clsOf = (id) => rec.imports.find((x) => x.id === id);
  const findings = /* @__PURE__ */ new Map(), closed = /* @__PURE__ */ new Map(), notes = [];
  const put = (key, f) => findings.set(key, { key, ...f });
  const idxOf = (imp) => {
    if (!ctx.rowIdx.has(imp.id)) {
      const t = parseTable(imp.text ?? "");
      ctx.rowIdx.set(imp.id, new Map(t.rows.map((r, n) => [JSON.stringify(r), n + 1])));
    }
    return ctx.rowIdx.get(imp.id);
  };
  const impById = new Map(prefix.map((i) => [i.id, i]));
  const vidrEvidence = (d) => {
    const imp = impById.get(d.current.importId), ix = imp ? idxOf(imp) : /* @__PURE__ */ new Map();
    return { importId: d.current.importId, fileName: imp?.fileName ?? null, role: "amazon", rows: d.evidence.rows.map((r) => ({ ref: `data row ${ix.get(JSON.stringify(r)) ?? "?"}`, cells: r })) };
  };
  const ledgerEvidence = (l) => {
    const imp = impById.get(l.importId), rd = readOf(imp);
    return { importId: l.importId, fileName: imp?.fileName ?? null, role: "accounting", rows: [{ ref: `row ${l.row}`, cells: Object.fromEntries((rd.head ?? []).map((h, i) => [h, l.raw[i]])) }] };
  };
  const readOf = (imp) => {
    const k = imp.id + "|" + imp.sha256;
    if (!ctx.led.has(k)) ctx.led.set(k, readLedger(imp.text ?? "", imp.profile, { importId: imp.id, amazonScope: imp.declared?.amazonScope ?? { mode: "UNKNOWN" }, sourceSystem: imp.declared?.sourceSystem ?? "" }));
    return ctx.led.get(k);
  };
  const fp = (...parts) => sha256(JSON.stringify(parts));
  const groups = /* @__PURE__ */ new Map();
  for (const i of prefix) {
    const k = descriptor(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const importDefects = /* @__PURE__ */ new Map();
  for (const i of prefix) {
    const defects = [], scopeNotes = [], d = i.declared ?? {};
    if (isLedger(i)) {
      const rd = readOf(i);
      defects.push(...rd.defects);
      if (d.complete !== true) scopeNotes.push("declared as a partial export: it can show that a document exists, never that one is missing");
      if ((d.amazonScope?.mode ?? "UNKNOWN") === "UNKNOWN") scopeNotes.push("not declared as Amazon sales, so nothing can be concluded about missing documents");
    } else {
      const c2 = clsOf(i.id);
      if (c2) {
        c2.problemCodes.forEach((code, n) => {
          if (DEFECT_CODES_EXCLUDED.includes(code)) scopeNotes.push(c2.problems[n]);
          else defects.push(c2.problems[n]);
        });
        if (c2.dateOrder && !c2.dateOrder.provenByFile && c2.dateOrder.sellerConfirmed !== true) defects.push("the order of the dates (day first or month first) is not proven by the file and was not confirmed by the seller");
      }
      if (d.reportType !== REPORT_TYPE) defects.push("the report type was not declared");
      if (!String(d.marketplace ?? "").trim()) defects.push("the marketplace was not declared");
      if (!(d.createdAfterUploadConfirmed && ms2(d.createdAt) !== null)) defects.push("it was not declared that the report was created after the upload, with its creation time");
      if (ms2(d.downloadedAt) === null) defects.push("the download time was not declared");
      if (!String(d.obtainedHow ?? "").trim()) defects.push("how the file was obtained was not declared");
    }
    importDefects.set(i.id, { defects, scopeNotes });
  }
  for (const [desc, list] of groups) {
    const latest = list[list.length - 1], full = list.filter(fullScope).at(-1), key = issueKey(ctx.seller, "SOURCE_INCOMPLETE", desc);
    const subjectOf = (x) => ({ descriptor: desc, source: isLedger(x) ? "accounting export" : "Amazon VAT invoice report", fileName: x.fileName ?? null });
    const raise = (x) => {
      const { defects } = importDefects.get(x.id);
      put(key, { family: "SOURCE_INCOMPLETE", subtype: "DEFECTS", status: "PRESENT", subject: subjectOf(x), evidence: { sources: [], defects, importId: x.id, fileName: x.fileName ?? null }, fingerprint: fp("SI", desc, defects), safeAction: true });
    };
    if (importDefects.get(latest.id).defects.length) raise(latest);
    else if (fullScope(latest)) closed.set(key, { why: "The latest import of this scope is complete.", importId: latest.id, fileName: latest.fileName ?? null });
    else if (full && importDefects.get(full.id).defects.length) raise(full);
    else if (full) closed.set(key, { why: "The latest complete import of this scope has no defects.", importId: full.id, fileName: full.fileName ?? null });
  }
  const usableVidr = (i) => {
    const { defects } = importDefects.get(i.id);
    const c2 = clsOf(i.id);
    return !defects.length && c2 && c2.declared.options === "ALL";
  };
  const A = rec.docs.filter((d) => d.parts["transaction-type"] === "SHIPMENT" && !d.correction && d.state !== "CREATED_BY_AMAZON");
  const stats = { amazonInvoices: A.length, createdByAmazon: rec.docs.filter((d) => d.state === "CREATED_BY_AMAZON").length, notOrdinaryInvoice: rec.docs.filter((d) => d.parts["transaction-type"] !== "SHIPMENT" || d.correction).length, processing: 0, ledgerAmazonInvoices: 0, ledgerExcludedNotAmazon: 0, ledgerCreditNotes: 0, ledgerUnknownScope: 0, ledgerRejectedRows: 0 };
  const afterAction = (key, d) => {
    const imp = impById.get(d.current.importId), acts = (ctx.actions.get(key) ?? []).filter((e) => ms2(e.createdAt) <= (ms2(imp?.importedAt) ?? Infinity));
    if (!acts.length) return true;
    const t = imp ? createdMs(imp) : null;
    return t !== null && t > Math.max(...acts.map((e) => ms2(e.createdAt)));
  };
  for (const d of A) {
    const id = amazonId(d), key = issueKey(ctx.seller, "INVOICE_AMAZON_STATE", id), subject = { amazonId: id, marketplace: d.parts["marketplace-id"], orderId: d.parts["order-id"], shippingId: d.parts["shipping-id"], transactionId: d.parts["transaction-id"] };
    const ev = { sources: [vidrEvidence(d)], state: d.state, statusAsShown: d.rawStatus, amazonDescription: d.evidence.statusDescription ?? null, invoiceNumber: d.evidence.invoiceNumber ?? null };
    if (d.state === "PENDING" || d.state === "SELLER_UPLOAD_REQUIRED") put(key, { family: "INVOICE_AMAZON_STATE", subtype: "ACTION_REQUIRED", status: "PRESENT", subject, evidence: ev, fingerprint: fp("IAS", id, d.state, d.rawStatus, d.evidence.rows), safeAction: true });
    else if (d.state === "REJECTED") put(key, { family: "INVOICE_AMAZON_STATE", subtype: "REJECTED", status: "PRESENT", subject, evidence: ev, fingerprint: fp("IAS", id, d.state, d.rawStatus, d.evidence.statusDescription, d.evidence.rows), safeAction: true });
    else if (d.state === "ACCEPTED" && !afterAction(key, d)) put(key, { family: "INVOICE_AMAZON_STATE", subtype: "ACCEPTED_BEFORE_ACTION", status: "UNDETERMINED", subject, evidence: ev, fingerprint: fp("IAS", id, "BEFORE", d.current.importId), note: `The report that shows this as accepted was created ${impById.get(d.current.importId)?.declared?.createdAt ?? "at an unknown time"}, which is not after the action you recorded. It cannot show the effect of that action. Load a report created after it.` });
    else if (d.state === "ACCEPTED") closed.set(key, { why: `A later report shows ${d.rawStatus} and every acceptance condition of the evidence contract is met.`, sources: ev.sources, importId: d.current.importId });
    else if (d.state === "PROCESSING") {
      stats.processing++;
      put(key, { family: "INVOICE_AMAZON_STATE", subtype: "PROCESSING", status: "UNDETERMINED", processing: true, subject, evidence: ev, fingerprint: fp("IAS", id, d.state), note: "Amazon's report shows this as processing. Amazon says no new upload is needed while it processes." });
    } else {
      put(key, { family: "INVOICE_AMAZON_STATE", subtype: "UNDETERMINED", status: "UNDETERMINED", subject, evidence: ev, fingerprint: fp("IAS", id, d.state), note: `Amazon's row says ${d.rawStatus}, but the file does not allow a conclusion: ${d.explanation ?? d.state}` });
      notes.push({ reason: `Amazon status could not be concluded (${d.state})`, subject: id });
    }
  }
  const activeLed = led.filter((i) => !led.some((j) => j !== i && descriptor(j) === descriptor(i) && led.indexOf(j) > led.indexOf(i) && j.declared?.complete === true && !importDefects.get(j.id).defects.length));
  const merged = /* @__PURE__ */ new Map();
  for (const i of activeLed) {
    const rd = readOf(i), mk = i.declared?.marketplace ?? "";
    stats.ledgerRejectedRows += rd.rejected.length;
    const seen = /* @__PURE__ */ new Map();
    for (const doc of rd.documents) {
      if (doc.kind === "credit_note") {
        stats.ledgerCreditNotes++;
        continue;
      }
      if (doc.isAmazon === false) {
        stats.ledgerExcludedNotAmazon++;
        continue;
      }
      if (doc.isAmazon === null) {
        stats.ledgerUnknownScope++;
        continue;
      }
      const level = i.declared?.documentLevel === "DOCUMENT" || i.declared?.documentLevel === "LINE" ? i.declared.documentLevel : null;
      const l = { ...doc, marketplace: mk, conflicting: false, level }, k = ledgerKey(l), c2 = JSON.stringify(level === "LINE" ? [doc.issueDate, doc.operationDate, doc.currency, doc.orderRef, doc.buyerTaxId] : [doc.issueDate, doc.operationDate, doc.currency, doc.gross, doc.net, doc.vat, doc.orderRef, doc.buyerTaxId]);
      if (seen.has(k)) {
        if (seen.get(k).c === c2) {
          if (level !== "LINE") seen.get(k).l.repeatRows = [...seen.get(k).l.repeatRows ?? [seen.get(k).l.row], doc.row];
        }
        if (seen.get(k).c !== c2) {
          seen.get(k).l.conflicting = true;
          seen.get(k).l.conflictRows = [...seen.get(k).l.conflictRows ?? [seen.get(k).l.row], doc.row];
        }
        continue;
      }
      const prev = merged.get(k);
      if (prev && (prev.conflicting || prev.repeatRows)) continue;
      seen.set(k, { c: c2, l });
      merged.set(k, l);
    }
  }
  const Le = [...merged.values()];
  stats.ledgerAmazonInvoices = Le.length;
  const byNum = /* @__PURE__ */ new Map(), aNum = /* @__PURE__ */ new Map(), aOrder = /* @__PURE__ */ new Map();
  for (const l of Le) {
    const k = l.marketplace + "|" + l.number;
    if (!byNum.has(k)) byNum.set(k, []);
    byNum.get(k).push(l);
  }
  for (const d of A) {
    const n = d.evidence.invoiceNumber;
    if (n) {
      const k = d.parts["marketplace-id"] + "|" + n;
      if (!aNum.has(k)) aNum.set(k, []);
      aNum.get(k).push(d);
    }
    const o = d.parts["marketplace-id"] + "|" + d.parts["order-id"];
    if (!aOrder.has(o)) aOrder.set(o, []);
    aOrder.get(o).push(d);
  }
  const link = /* @__PURE__ */ new Map(), ledLink = /* @__PURE__ */ new Map();
  const setA = (d, v) => link.set(amazonId(d), v), addL = (l, v) => {
    const c2 = ledLink.get(ledgerKey(l)) ?? { level: null, amazon: [], note: null };
    ledLink.set(ledgerKey(l), { ...c2, ...v, amazon: uniq2([...c2.amazon ?? [], ...v.amazon ?? []]) });
  };
  for (const d of A) {
    const n = d.evidence.invoiceNumber, mk = d.parts["marketplace-id"];
    if (n) {
      const Lc = byNum.get(mk + "|" + n) ?? [];
      if (Lc.length === 1 && !Lc[0].conflicting && aNum.get(mk + "|" + n).length === 1) {
        setA(d, { level: "CONFIRMED", ledger: [ledgerKey(Lc[0])] });
        addL(Lc[0], { level: "CONFIRMED", amazon: [amazonId(d)] });
        continue;
      }
      if (Lc.length) {
        setA(d, { level: "AMBIGUOUS", ledger: Lc.map(ledgerKey), why: Lc.length > 1 ? `${Lc.length} accounting documents carry the number ${n}` : Lc[0].conflicting ? `the accounting document ${n} appears twice in one file with different content` : `${aNum.get(mk + "|" + n).length} Amazon transactions show the number ${n}` });
        Lc.forEach((l) => addL(l, { level: "AMBIGUOUS", amazon: [amazonId(d)] }));
        continue;
      }
    }
    const Lo = Le.filter((l) => l.marketplace === mk && l.orderRef === d.parts["order-id"]);
    if (n && Lo.length) {
      setA(d, { level: "OTHER_NUMBER", ledger: Lo.map(ledgerKey) });
      Lo.forEach((l) => addL(l, { level: ledLink.get(ledgerKey(l))?.level ?? "OTHER_NUMBER", amazon: [amazonId(d)] }));
      continue;
    }
    if (!n && Lo.length) {
      const sameOrder = (aOrder.get(mk + "|" + d.parts["order-id"]) ?? []).filter((x) => !x.evidence.invoiceNumber);
      if (Lo.length === 1 && sameOrder.length === 1 && !Lo[0].conflicting) {
        setA(d, { level: "PROPOSED", ledger: [ledgerKey(Lo[0])] });
        addL(Lo[0], { level: "PROPOSED", amazon: [amazonId(d)] });
      } else {
        setA(d, { level: "AMBIGUOUS", ledger: Lo.map(ledgerKey), why: Lo.length > 1 ? `${Lo.length} accounting documents name the order ${d.parts["order-id"]}` : `${sameOrder.length} Amazon transactions of the order ${d.parts["order-id"]} could belong to it` });
        Lo.forEach((l) => addL(l, { level: "AMBIGUOUS", amazon: [amazonId(d)] }));
      }
    }
  }
  const decisions = /* @__PURE__ */ new Map();
  for (const e of events.filter((e2) => e2.type === "LINK_DECISION" && !eventShapeProblem(e2)).sort((a, b) => ms2(a.createdAt) - ms2(b.createdAt))) decisions.set(e.amazonId + ">" + e.ledgerKey, e);
  for (const d of A) {
    const l = link.get(amazonId(d));
    if (l?.level !== "PROPOSED") continue;
    const e = decisions.get(amazonId(d) + ">" + l.ledger[0]);
    if (!e) continue;
    const lk = Le.find((x) => ledgerKey(x) === l.ledger[0]);
    if (e.decision === "CONFIRM") {
      link.set(amazonId(d), { level: "DECLARED", ledger: l.ledger, event: e });
      ledLink.set(l.ledger[0], { level: "DECLARED", amazon: [amazonId(d)], event: e });
    } else {
      link.set(amazonId(d), { level: "REJECTED_PROPOSAL", ledger: l.ledger });
      ledLink.set(l.ledger[0], { level: "REJECTED_PROPOSAL", amazon: [amazonId(d)] });
      void lk;
    }
  }
  const FIELD_LABEL = { issueDate: "issue date", operationDate: "operation date", currency: "currency", orderRef: "order reference", buyerTaxId: "buyer tax id" };
  const disagreeing = (l) => {
    const rd = readOf(impById.get(l.importId)), docs = rd.documents.filter((x) => x.identity === l.identity);
    return Object.keys(FIELD_LABEL).filter((f) => new Set(docs.map((x) => String(x[f] ?? ""))).size > 1).map((f) => ({ field: f, label: FIELD_LABEL[f], values: docs.map((x) => ({ row: `row ${x.row}`, value: x[f] ?? null })) }));
  };
  const rowsOfIdentity = (l) => {
    const imp = impById.get(l.importId), rd = readOf(imp);
    return rd.documents.filter((x) => x.identity === l.identity).map((x) => ({ ref: `row ${x.row}`, cells: Object.fromEntries((rd.head ?? []).map((h, i) => [h, x.raw[i]])) }));
  };
  for (const l of Le) {
    const lk = ledgerKey(l), key = issueKey(ctx.seller, "DUPLICATE_DOCUMENT", "L:" + lk), subject = { ledgerKey: lk, number: l.number, marketplace: l.marketplace, issueDate: l.issueDate };
    if (l.conflicting || l.repeatRows) {
      const rows = rowsOfIdentity(l), unknownLevel = l.level === null, sub = unknownLevel ? "SUSPECTED_DUPLICATE" : l.conflicting ? "SAME_NUMBER_DIFFERENT_CONTENT" : "EXACT_REPEAT";
      put(key, { family: "DUPLICATE_DOCUMENT", subtype: sub, status: "PRESENT", subject, evidence: { sources: [{ importId: l.importId, fileName: impById.get(l.importId)?.fileName ?? null, role: "accounting", rows }], rowNumbers: rows.map((r) => r.ref), documentLevel: l.level, ...l.level === "LINE" && l.conflicting ? { disagreeingFields: disagreeing(l) } : {} }, fingerprint: fp("DUP", lk, sub, rows.map((r) => r.cells)), ...unknownLevel ? { note: "The export does not say whether one row is a whole document or one line of a document, so repeated rows cannot be called a duplicate." } : { safeAction: true } });
    } else closed.set(key, { why: l.level === "LINE" ? `The file is declared by the seller as one row per line item, so repeated rows of ${l.number} are expected.` : `The latest active accounting file holds the document ${l.number} once.`, sources: [ledgerEvidence(l)], importId: l.importId });
  }
  const money = (v) => /^-?\d+(\.\d{1,2})?$/.test(String(v ?? "").trim()) ? readMoney(String(v).trim(), ".", "") : null;
  const taxNorm = (v) => String(v ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const fmt = (m, cur) => `${m < 0 ? "-" : ""}${Math.floor(Math.abs(m) / 100)}.${String(Math.abs(m) % 100).padStart(2, "0")} ${cur}`;
  const mismatchFields = /* @__PURE__ */ new Map();
  for (const d of A) {
    const L = link.get(amazonId(d));
    if (L?.level !== "CONFIRMED") continue;
    const l = merged.get(L.ledger[0]);
    if (!l) continue;
    const id = amazonId(d), key = issueKey(ctx.seller, "DATA_MISMATCH", id + ">" + ledgerKey(l)), rows = d.evidence.rows, diffs = [], notCompared = [];
    const subject = { amazonId: id, ledgerKey: ledgerKey(l), number: l.number, marketplace: d.parts["marketplace-id"], orderId: d.parts["order-id"], shippingId: d.parts["shipping-id"], transactionId: d.parts["transaction-id"] };
    const curs = uniq2(rows.map((r) => String(r.currency ?? "").trim().toUpperCase())), aCur = curs.length === 1 && /^[A-Z]{3}$/.test(curs[0]) ? curs[0] : null;
    let sameCur = false;
    if (aCur && l.currency) {
      sameCur = aCur === l.currency;
      if (!sameCur) diffs.push({ field: "currency", label: "Currency", amazon: aCur, books: l.currency });
    } else notCompared.push({ field: "currency", reason: "the currency is not stated exactly on both sides" });
    if (!sameCur) notCompared.push({ field: "gross", reason: aCur && l.currency ? "the two sides use different currencies, and the Amazon report states the item price, not the invoice total" : "the currency is not stated exactly on both sides" });
    else notCompared.push({ field: "gross", reason: "the Amazon report states the item price, not the invoice total (shipping, gift wrap and discounts are separate amounts), so the invoice total cannot be compared reliably in this version" });
    const btxRaw = rows.map((r) => taxNorm(r["buyer-vat-number"])), btx = uniq2(btxRaw.filter(Boolean)), btxAll = btxRaw.every(Boolean);
    if (btxAll && btx.length === 1 && taxNorm(l.buyerTaxId)) {
      if (btx[0] !== taxNorm(l.buyerTaxId)) diffs.push({ field: "buyerTaxId", label: "Buyer tax id", amazon: btx[0], books: taxNorm(l.buyerTaxId) });
    } else notCompared.push({ field: "buyerTaxId", reason: btx.length > 1 ? "the Amazon rows of this transaction show different buyer tax ids" : !btx.length ? "the Amazon report shows no buyer tax id" : !btxAll ? "only some Amazon rows of this transaction carry a buyer tax id" : "the accounting export shows no buyer tax id" });
    notCompared.push({ field: "netAndVat", reason: "net and VAT amounts are not read from the Amazon report in this version" });
    const sources = [vidrEvidence(d), ledgerEvidence(l)];
    if (diffs.length) {
      mismatchFields.set(key, new Set(diffs.map((x) => x.field)));
      put(key, { family: "DATA_MISMATCH", subtype: "FIELDS_DIFFER", status: "PRESENT", subject, evidence: { sources, differences: diffs, notCompared }, fingerprint: fp("DM", id, ledgerKey(l), diffs, l.raw), safeAction: true });
    } else {
      const was = ctx.prevMismatch.get(key);
      if (was && [...was].some((f) => notCompared.some((n) => n.field === f))) put(key, { family: "DATA_MISMATCH", subtype: "CANNOT_CONFIRM", status: "UNDETERMINED", subject, evidence: { sources, differences: [], notCompared }, fingerprint: fp("DM", id, ledgerKey(l), "CANNOT"), note: "The difference is no longer shown, but a field that differed can no longer be compared, so it cannot be called agreed." });
      else closed.set(key, { why: "The compared values (currency and buyer tax id, where both sides state them) agree on the same confirmed pair.", sources, importId: l.importId });
    }
  }
  const booksCover = (d) => {
    const mk = d.parts["marketplace-id"], ship = String(d.evidence.rows[0]?.["shipment-date"] ?? "").slice(0, 10), imp = impById.get(d.current.importId), rep = imp ? day(imp.declared?.createdAt) ?? day(imp.declared?.downloadedAt) : null;
    const why = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ship)) return { ok: false, why: ["the Amazon row has no readable shipment date"] };
    if (!rep) return { ok: false, why: ["the day the Amazon report was taken is not declared"] };
    if (!activeLed.length) return { ok: false, why: ["no accounting export has been loaded"] };
    for (const i of activeLed) {
      const g = i.declared ?? [], r = [];
      const dd = i.declared ?? {};
      if (dd.marketplace !== mk) r.push(`it is declared for marketplace ${dd.marketplace}, not ${mk}`);
      if (dd.complete !== true) r.push("it is not declared as a complete export");
      const expT = ms2(dd.exportedAt), repT = imp ? ms2(imp.declared?.createdAt) ?? ms2(imp.declared?.downloadedAt) : null;
      if (expT === null) r.push("the time this accounting export was created is not declared, so it cannot show that the invoice was missing when the Amazon report was taken");
      else if (repT !== null && expT < repT) r.push(`it was exported at ${dd.exportedAt}, before the Amazon report was created (${imp.declared.createdAt}), so it cannot show what the books held on that day`);
      if (!["ALL", "CHANNEL"].includes(dd.amazonScope?.mode)) r.push("it is not declared as Amazon sales");
      if (!(dd.documentKinds ?? []).includes("invoice")) r.push("it does not declare that it covers invoices");
      if (importDefects.get(i.id).defects.length) r.push("the file has defects: " + importDefects.get(i.id).defects.join("; "));
      if (!(dd.periodFrom <= ship && dd.periodTo >= ship && dd.periodTo >= rep)) r.push(`its period ${dd.periodFrom} to ${dd.periodTo} must start on or before the shipment day ${ship} and end on or after the shipment day and the day the Amazon report was taken (${rep})`);
      if (!r.length) return { ok: true, import: { id: i.id, fileName: i.fileName ?? null, period: `${dd.periodFrom} to ${dd.periodTo}`, sourceSystem: dd.sourceSystem, exportedAt: dd.exportedAt, exportedAtBasis: "declared by the seller" } };
      why.push(`${i.fileName ?? i.id}: ${r.join("; ")}`);
      void g;
    }
    return { ok: false, why };
  };
  const vidrCover = (l) => {
    if (!l.operationDate) return { ok: false, why: ["the document has no operation date, so we cannot tell which Amazon report would show it"] };
    const why = [];
    for (const i of vidr) {
      const c2 = clsOf(i.id), dd = i.declared ?? {}, r = [];
      if (dd.marketplace !== l.marketplace) r.push(`it is for marketplace ${dd.marketplace}`);
      if (!usableVidr(i)) r.push("it is not a complete all-statuses report");
      else if (!(c2.declared.rangeFrom <= l.operationDate && l.operationDate <= c2.declared.rangeTo)) r.push(`its range ${c2.declared.rangeFrom} to ${c2.declared.rangeTo} does not contain the operation date ${l.operationDate}`);
      const rep = day(dd.createdAt) ?? day(dd.downloadedAt);
      if (!rep || rep < l.issueDate) r.push("it was not taken on or after the issue date of the document");
      if (!r.length) return { ok: true, import: { id: i.id, fileName: i.fileName ?? null, range: `${c2.declared.rangeFrom} to ${c2.declared.rangeTo}` } };
      why.push(`${i.fileName ?? i.id}: ${r.join("; ")}`);
    }
    return { ok: false, why: why.length ? why : ["no Amazon report has been loaded"] };
  };
  const noteGroup = /* @__PURE__ */ new Map();
  const noteAdd = (reason, subject) => {
    const k = reason;
    if (!noteGroup.has(k)) noteGroup.set(k, { reason, count: 0, sample: [] });
    const g = noteGroup.get(k);
    g.count++;
    if (g.sample.length < 5) g.sample.push(subject);
  };
  for (const d of A) {
    if (!["PENDING", "SELLER_UPLOAD_REQUIRED", "REJECTED", "PROCESSING", "ACCEPTED"].includes(d.state)) continue;
    const id = amazonId(d), key = issueKey(ctx.seller, "BOOKS_GAP", id), L = link.get(id), subject = { amazonId: id, marketplace: d.parts["marketplace-id"], orderId: d.parts["order-id"], shippingId: d.parts["shipping-id"], transactionId: d.parts["transaction-id"] };
    const number = d.evidence.invoiceNumber ?? null, base = { sources: [vidrEvidence(d)], amazonState: d.state, invoiceNumberAtAmazon: number };
    if (L?.level === "CONFIRMED") {
      const l = merged.get(L.ledger[0]);
      closed.set(key, { why: `The accounting document ${l.number} matches the number Amazon shows, and it is the only one.`, sources: [ledgerEvidence(l)], importId: l.importId });
      continue;
    }
    if (L?.level === "DECLARED") {
      const l = merged.get(L.ledger[0]);
      put(key, { family: "BOOKS_GAP", subtype: number ? "NUMBER_AT_AMAZON_NOT_IN_BOOKS" : "NOT_IN_BOOKS", status: "DECLARED_LINK", declared: { event: L.event }, subject, evidence: { ...base, declaredLink: { document: l.number, by: L.event.author, reasoning: L.event.reasoning } }, fingerprint: fp("BG", id, "DECLARED", ledgerKey(l), L.event.id ?? L.event.createdAt), safeAction: true });
      continue;
    }
    if (L && ["PROPOSED", "AMBIGUOUS", "OTHER_NUMBER"].includes(L.level)) {
      put(key, { family: "BOOKS_GAP", subtype: "UNDETERMINED", status: "UNDETERMINED", subject, evidence: base, fingerprint: fp("BG", id, L.level, L.ledger), note: L.level === "PROPOSED" ? "An accounting document for this order exists but is not confirmed as the same document. See the matching problem." : L.level === "AMBIGUOUS" ? `More than one document could belong to this transaction: ${L.why}.` : "An accounting document for the same order exists under a different number. Comparing numbers is not part of this version." });
      if (L.level === "OTHER_NUMBER") noteAdd("A document for the same order is in the books under a different number than Amazon shows (comparison not part of this version)", id);
      continue;
    }
    const cov = booksCover(d);
    if (!cov.ok) {
      put(key, { family: "BOOKS_GAP", subtype: "UNDETERMINED", status: "UNDETERMINED", subject, evidence: base, fingerprint: fp("BG", id, "NOCOV", cov.why), note: "Absence from the books cannot be concluded: " + cov.why.join(" | ") });
      noteAdd("Absence from the books cannot be concluded: " + cov.why[0].replace(/^[^:]*: /, ""), id);
      continue;
    }
    put(key, { family: "BOOKS_GAP", subtype: number ? "NUMBER_AT_AMAZON_NOT_IN_BOOKS" : "NOT_IN_BOOKS", status: "PRESENT", subject, evidence: { ...base, coverage: cov.import }, fingerprint: fp("BG", id, number, d.state, d.evidence.rows), safeAction: true });
  }
  for (const l of Le) {
    const lk = ledgerKey(l), key = issueKey(ctx.seller, "UNMATCHED_DOCUMENT", "L:" + lk), L = ledLink.get(lk), subject = { ledgerKey: lk, number: l.number, marketplace: l.marketplace, orderRef: l.orderRef, issueDate: l.issueDate };
    const ev = { sources: [ledgerEvidence(l)], document: { number: l.number, issueDate: l.issueDate, orderRef: l.orderRef, operationDate: l.operationDate } };
    if (l.conflicting) continue;
    if (L?.level === "CONFIRMED") {
      const a = A.find((x) => amazonId(x) === L.amazon[0]);
      closed.set(key, { why: `Amazon shows the same number (${l.number}) on one transaction.`, sources: a ? [vidrEvidence(a)] : [], importId: a?.current.importId });
      continue;
    }
    if (L?.level === "DECLARED") {
      put(key, { family: "UNMATCHED_DOCUMENT", subtype: "PROPOSED_LINK_UNCONFIRMED", status: "PRESENT", declared: { event: L.event }, subject, evidence: ev, fingerprint: fp("UD", lk, "DECLARED", L.amazon, L.event.id ?? L.event.createdAt), safeAction: true });
      continue;
    }
    if (L?.level === "PROPOSED") {
      const a = A.find((x) => amazonId(x) === L.amazon[0]);
      put(key, { family: "UNMATCHED_DOCUMENT", subtype: "PROPOSED_LINK_UNCONFIRMED", status: "PRESENT", subject, evidence: { ...ev, candidate: { amazonId: L.amazon[0], sources: a ? [vidrEvidence(a)] : [] } }, fingerprint: fp("UD", lk, "PROPOSED", l.raw, L.amazon, a?.evidence.rows), safeAction: true });
      continue;
    }
    if (L?.level === "AMBIGUOUS") {
      put(key, { family: "UNMATCHED_DOCUMENT", subtype: "MULTIPLE_CANDIDATES", status: "PRESENT", subject, evidence: { ...ev, why: `more than one Amazon transaction could belong to it (${L.amazon.length})`, candidates: L.amazon }, fingerprint: fp("UD", lk, "AMBIG", l.raw, L.amazon) });
      continue;
    }
    if (L?.level === "OTHER_NUMBER") {
      noteAdd("A document for the same order is in the books under a different number than Amazon shows (comparison not part of this version)", lk);
      continue;
    }
    const cov = vidrCover(l);
    if (!cov.ok) {
      noteAdd("Absence from Amazon cannot be concluded: " + cov.why[0].replace(/^[^:]*: /, ""), lk);
      put(key, { family: "UNMATCHED_DOCUMENT", subtype: "UNDETERMINED", status: "UNDETERMINED", subject, evidence: ev, fingerprint: fp("UD", lk, "NOCOV", cov.why), note: "Absence from Amazon cannot be concluded: " + cov.why.join(" | ") });
      continue;
    }
    put(key, { family: "UNMATCHED_DOCUMENT", subtype: "NO_CANDIDATE", status: "PRESENT", subject, evidence: { ...ev, coverage: cov.import }, fingerprint: fp("UD", lk, "NOCAND", l.raw, l.issueDate, l.operationDate), safeAction: true });
  }
  const covNotes = [...noteGroup.values()].sort((a, b) => a.reason.localeCompare(b.reason));
  const docsFine = A.filter((d) => d.state === "ACCEPTED" && link.get(amazonId(d))?.level === "CONFIRMED").length;
  return { mismatchFields, findings, closed, notes: covNotes, stats: { ...stats, matchedByInvoiceNumber: docsFine }, links: { link, ledLink }, amazonDocs: A, importDefects, ledgerDocs: Le };
}
function project({ imports, events = [], sellerProfileId = "local" }) {
  const ordered = orderImports(imports), ctx = { seller: sellerProfileId, led: /* @__PURE__ */ new Map(), rowIdx: /* @__PURE__ */ new Map(), actions: /* @__PURE__ */ new Map(), prevMismatch: /* @__PURE__ */ new Map() };
  const rejectedEvents = [], goodEvents = [];
  for (const e of events) {
    const p = eventShapeProblem(e);
    if (p) rejectedEvents.push({ event: e, reason: p });
    else goodEvents.push(e);
  }
  for (const e of goodEvents) if (e.type === "ACTION_STARTED") {
    if (!ctx.actions.has(e.issueKey)) ctx.actions.set(e.issueKey, []);
    ctx.actions.get(e.issueKey).push(e);
  }
  const hist = /* @__PURE__ */ new Map();
  let last = { findings: /* @__PURE__ */ new Map(), closed: /* @__PURE__ */ new Map(), notes: [], stats: {}, links: {}, amazonDocs: [], importDefects: /* @__PURE__ */ new Map(), ledgerDocs: [] };
  const n = ordered.length;
  for (let k = 0; k < n; k++) {
    const horizon = k < n - 1 ? Math.min(...ordered.slice(k + 1).map((i) => ms2(i.importedAt) ?? Infinity)) : Infinity;
    const ev = evaluate(ordered.slice(0, k + 1), goodEvents.filter((e) => ms2(e.createdAt) < horizon), ctx), imp = ordered[k];
    const seen = /* @__PURE__ */ new Set();
    for (const [key, f] of ev.findings) {
      seen.add(key);
      if ((f.status === "UNDETERMINED" || f.status === "DECLARED_LINK") && !hist.get(key)?.some((h) => h.status === "PRESENT")) continue;
      if (!hist.has(key)) hist.set(key, []);
      hist.get(key).push({ k, importId: imp.id, fileName: imp.fileName ?? null, status: f.status, subtype: f.subtype, family: f.family, subject: f.subject, evidence: f.evidence, fingerprint: f.fingerprint, note: f.note ?? null });
    }
    for (const [key, c2] of ev.closed) {
      seen.add(key);
      if (hist.has(key)) hist.get(key).push({ k, importId: imp.id, fileName: imp.fileName ?? null, status: "CLOSED", closure: c2 });
    }
    for (const [key, h] of hist) if (!seen.has(key) && h.at(-1).k !== k) h.push({ k, importId: imp.id, fileName: imp.fileName ?? null, status: "UNDETERMINED", note: "Not evaluated in this set of files." });
    for (const [key, fs] of ev.mismatchFields ?? []) ctx.prevMismatch.set(key, fs);
    for (const key of ev.closed.keys()) ctx.prevMismatch.delete(key);
    last = ev;
  }
  const issues = [];
  for (const [key, h] of hist) {
    if (!h.some((x) => x.status === "PRESENT")) continue;
    const final = h.at(-1), live = last.findings.get(key), pastP = h.findLast((x) => x.status === "PRESENT"), f = live ?? { family: pastP.family, subtype: pastP.subtype, subject: pastP.subject, fingerprint: null, safeAction: false }, closure = last.closed.get(key);
    const episodes = [];
    let cur = null;
    for (const x of h) {
      if (x.status === "PRESENT" || x.status === "DECLARED_LINK") {
        if (!cur) {
          cur = { from: x.importId, fromFile: x.fileName, to: null, closedBy: null };
          episodes.push(cur);
        }
        cur.last = x.importId;
      } else if (x.status === "CLOSED" && cur) {
        cur.to = x.importId;
        cur.closedBy = x.closure;
        cur = null;
      }
    }
    let state, outcome = null, awaiting = null, declaration = null, lapsed = [];
    if (final.status === "CLOSED") {
      state = "VERIFIED_CLOSED";
      outcome = "evidence";
    } else {
      const family = f.family;
      const decls = goodEvents.filter((e) => e.issueKey === key && DECLARATION_TYPES.includes(e.type)).sort((a, b) => ms2(a.createdAt) - ms2(b.createdAt));
      for (const e of decls) {
        const bad = declarationProblem(e, family, f.subtype);
        if (bad) {
          rejectedEvents.push({ event: e, reason: bad });
          continue;
        }
        if (final.status === "PRESENT" && e.basedOnFingerprint === f.fingerprint) declaration = e;
        else lapsed.push(e);
      }
      const started = goodEvents.filter((e) => e.issueKey === key && e.type === "ACTION_STARTED").sort((a, b) => ms2(a.createdAt) - ms2(b.createdAt)).at(-1);
      const relevant = (i) => f.family === "INVOICE_AMAZON_STATE" ? !isLedger(i) && h.some((x) => x.importId === i.id) : f.family === "SOURCE_INCOMPLETE" ? descriptor(i) === f.subject.descriptor : f.subject.marketplace ? i.declared?.marketplace === f.subject.marketplace : true;
      const newer = started ? ordered.filter((i) => createdMs(i) !== null && createdMs(i) > ms2(started.createdAt) && relevant(i)) : [];
      if ((final.status === "PRESENT" || final.status === "DECLARED_LINK") && f.declared) {
        state = "MANUALLY_REPORTED_RESOLUTION";
        outcome = "declaration";
        declaration = f.declared.event;
      } else if (declaration) {
        state = "MANUALLY_REPORTED_RESOLUTION";
        outcome = "declaration";
      } else if (final.status === "UNDETERMINED" && f?.processing) {
        state = "AWAITING_NEW_EVIDENCE";
        awaiting = "AMAZON_PROCESSING";
      } else if (started && !newer.length) {
        state = "AWAITING_NEW_EVIDENCE";
        awaiting = "SELLER_REPORTED_ACTION";
      } else if (final.status === "UNDETERMINED") state = "OPEN";
      else state = f.safeAction ? "ACTION_REQUIRED" : "OPEN";
    }
    const shown = live ?? null, pastFinding = { family: f.family, subtype: f.subtype, subject: f.subject };
    const issue = {
      key,
      family: pastFinding.family,
      subtype: pastFinding.subtype,
      state,
      outcome,
      awaiting,
      subject: pastFinding.subject,
      reopened: episodes.length > 1,
      episodes,
      history: h.map((x) => ({ import: x.importId, file: x.fileName, status: x.status, subtype: x.subtype ?? null, note: x.note ?? null })),
      events: goodEvents.filter((e) => e.issueKey === key).map((e) => ({ id: e.id ?? null, type: e.type, kind: e.kind ?? null, author: e.author, createdAt: e.createdAt, reasoning: e.reasoning })),
      lapsedDeclarations: lapsed.map((e) => ({ author: e.author, createdAt: e.createdAt, reasoning: e.reasoning })),
      declaration: declaration ? { author: declaration.author, createdAt: declaration.createdAt, reasoning: declaration.reasoning, kind: declaration.kind ?? declaration.type } : null,
      fingerprint: shown?.fingerprint ?? null,
      closure: final.status === "CLOSED" ? closure ?? final.closure : null,
      finding: shown ? { evidence: shown.evidence, note: shown.note ?? null } : { evidence: pastP.evidence, note: null, lastSeen: true }
    };
    issue.card = buildCard(issue);
    issues.push(issue);
  }
  issues.sort((a, b) => a.key.localeCompare(b.key));
  const count = (s) => issues.filter((i) => i.state === s).length;
  const buckets = {
    matchedByInvoiceNumber: last.stats.matchedByInvoiceNumber ?? 0,
    inProgressAtAmazon: last.stats.processing ?? 0,
    needsActionNow: count("ACTION_REQUIRED"),
    needsHumanReading: count("OPEN"),
    awaitingNewEvidence: count("AWAITING_NEW_EVIDENCE"),
    cannotDetermine: last.notes.reduce((n2, g) => n2 + g.count, 0),
    reportedResolvedBySeller: count("MANUALLY_REPORTED_RESOLUTION"),
    closedWithEvidence: count("VERIFIED_CLOSED")
  };
  return {
    loopVersion: LOOP_VERSION,
    keyVersion: KEY_VERSION,
    sellerProfileId,
    issues,
    buckets,
    coverageNotes: last.notes,
    stats: last.stats,
    rejectedEvents,
    notCheckedInThisVersion: NOT_CHECKED_IN_THIS_VERSION,
    imports: ordered.map((i) => ({ id: i.id, kind: isLedger(i) ? "ledger" : "vidr", fileName: i.fileName ?? null, importedAt: i.importedAt, descriptor: descriptor(i), defects: last.importDefects.get(i.id)?.defects ?? [], scopeNotes: last.importDefects.get(i.id)?.scopeNotes ?? [] }))
  };
}

// src/loop/store.js
var isoDay2 = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
var Refused = class extends Error {
  constructor(reasons) {
    super(reasons.join(" "));
    this.code = "REFUSED";
    this.reasons = reasons;
  }
};
var hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
function vidrDoorProblems(text, d = {}) {
  const p = [];
  for (const k of ["marketplace"]) if (!String(d[k] ?? "").trim()) p.push(`Missing: ${k}.`);
  if (!isoDay2(d.rangeFrom) || !isoDay2(d.rangeTo)) p.push("Missing: the date range of the report (from and to, as YYYY-MM-DD).");
  if (!["ALL", "PENDING_ONLY"].includes(d.options)) p.push("Missing: which report options were used (all statuses, or pending only).");
  const t = parseTable(text);
  if (t.unsupported || !t.rows.length) p.push(t.unsupported ?? "The file has no data rows.");
  return p;
}
function ledgerDoorProblems(text, profile, d = {}) {
  const p = [];
  if (!String(d.sourceSystem ?? "").trim()) p.push("Missing: the name of the accounting system.");
  if (!String(d.marketplace ?? "").trim()) p.push("Missing: the Amazon marketplace this export is declared for.");
  if (d.exportedAt !== void 0 && d.exportedAt !== "" && Number.isNaN(Date.parse(d.exportedAt))) p.push("The export time is not a readable date and time.");
  if (!isoDay2(d.periodFrom) || !isoDay2(d.periodTo)) p.push("Missing: the period of the export (from and to, as YYYY-MM-DD).");
  if (!Array.isArray(d.documentKinds) || !d.documentKinds.length || d.documentKinds.some((k) => !["invoice", "credit_note"].includes(k))) p.push("Missing: which document kinds the export contains.");
  if (typeof d.complete !== "boolean") p.push("Missing: whether this is a complete export of that period (yes or no).");
  const m = d.amazonScope?.mode;
  if (!["ALL", "CHANNEL", "UNKNOWN"].includes(m)) p.push("Missing: whether these documents are Amazon sales (all of them, only those in a channel column, or not declared).");
  if (m === "CHANNEL" && (!(d.amazonScope.channelValues ?? []).length || !profile?.columns?.channel)) p.push("A channel-based Amazon declaration needs the channel column mapped and the channel values that mean Amazon.");
  const t = readDelimited(text, profile?.delimiter ?? null);
  if (!t.ok) p.push(t.error);
  else p.push(...profileProblems(profile, t.head));
  return p;
}
var sig = (r) => JSON.stringify(r.issues.map((i) => [i.key, i.state, i.fingerprint]).sort());
function orphanedEvents(events, after, imports, pid) {
  const keys = new Set(after.issues.map((i) => i.key)), base = sig(after);
  return events.filter((e) => e.type === "LINK_DECISION" ? sig(project({ imports, events: events.filter((x) => x !== e), sellerProfileId: pid })) === base : !keys.has(e.issueKey));
}
function createLoopStore(adapter, { now = () => (/* @__PURE__ */ new Date()).toISOString() } = {}) {
  const key = (k, id) => `loop:${k}:${id}`;
  const list = async (k) => {
    const out = [];
    for (const x of (await adapter.list()).filter((x2) => String(x2).startsWith(`loop:${k}:`)).sort()) out.push(await adapter.get(x));
    return out;
  };
  let seq = 0;
  const api = {
    async profileId() {
      let p = await adapter.get("loop:profile");
      if (!p) {
        p = { id: "p-" + hex(8), createdAt: now() };
        await adapter.put("loop:profile", p);
      }
      return p.id;
    },
    async addVidr({ text, declared, fileName = null }) {
      const p = vidrDoorProblems(text, declared);
      if (p.length) throw new Refused(p);
      const sha = sha256(text), rec = { id: `imp-${now().replace(/\D/g, "").slice(0, 14)}-${sha.slice(0, 6)}-${seq++}`, kind: "vidr", fileName, text, sha256: sha, declared, importedAt: now() };
      await adapter.put(key("import", rec.id), rec);
      return rec.id;
    },
    async addLedger({ text, profile, declared, fileName = null }) {
      const p = ledgerDoorProblems(text, profile, declared);
      if (p.length) throw new Refused(p);
      const sha = sha256(text), rec = { id: `imp-${now().replace(/\D/g, "").slice(0, 14)}-${sha.slice(0, 6)}-${seq++}`, kind: "ledger", fileName, text, sha256: sha, declared, profile: { ...profile, savedWith: PARSER_VERSION }, importedAt: now() };
      await adapter.put(key("import", rec.id), rec);
      return rec.id;
    },
    async imports() {
      return list("import");
    },
    async events() {
      return list("event");
    },
    async project() {
      return project({ imports: await this.imports(), events: await this.events(), sellerProfileId: await this.profileId() });
    },
    /** Records what the seller said. It checks the event against the current projection and refuses what the problem does not accept. It never writes a state. */
    async addEvent(e) {
      const ev = { ...e, createdAt: e.createdAt ?? now() }, bad = eventShapeProblem(ev);
      if (bad) throw new Refused([bad]);
      const r = await this.project();
      if (ev.type === "LINK_DECISION") {
        const hit = r.issues.find((i) => i.family === "UNMATCHED_DOCUMENT" && i.subtype === "PROPOSED_LINK_UNCONFIRMED" && i.subject?.ledgerKey === ev.ledgerKey && i.finding?.evidence?.candidate?.amazonId === ev.amazonId);
        if (!hit) throw new Refused(["There is no open proposal for that pair of documents, so there is nothing to confirm or reject."]);
      } else {
        const issue = r.issues.find((i) => i.key === ev.issueKey);
        if (!issue) throw new Refused(["That problem is not in the current results."]);
        if (issue.state === "VERIFIED_CLOSED") throw new Refused(["That problem is already closed by evidence."]);
        if (DECLARATION_TYPES.includes(ev.type)) {
          const d = declarationProblem(ev, issue.family, issue.subtype);
          if (d) throw new Refused([d]);
          ev.basedOnFingerprint = issue.fingerprint;
        } else ev.basedOnFingerprint = issue.fingerprint;
      }
      ev.id = `ev-${ev.createdAt.replace(/\D/g, "")}-${seq++}`;
      await adapter.put(key("event", ev.id), ev);
      return ev.id;
    },
    /** Evidence bundle: inputs, events, and the projection with what each closure rests on. No field adds declared resolutions to evidence-closed ones. */
    async bundle() {
      const r = await this.project(), imports = await this.imports(), events = await this.events();
      const b = r.buckets;
      return {
        bundleVersion: 1,
        kind: "problem-loop",
        loopVersion: LOOP_VERSION,
        keyVersion: KEY_VERSION,
        sellerProfileId: r.sellerProfileId,
        createdAt: now(),
        matchedByInvoiceNumberMeaning: "Matched by invoice number means an Amazon transaction and an accounting document carry the same document number. For each such pair the currency and the buyer tax id are compared where both sides state them exactly, and all differences of a pair are shown in one problem. The invoice total (the Amazon report states the item price, not the invoice total), net and VAT amounts, dates, line items and tax rates are not compared in this version.",
        note: "State of the loaded files on the dates they were loaded. Anything marked declared was said by the seller and is not confirmed by a file. No statement here is about the legal position of any document.",
        imports: imports.map((i) => ({ id: i.id, kind: i.kind, fileName: i.fileName, sha256: i.sha256, importedAt: i.importedAt, declared: i.declared, profile: i.profile ?? null, text: i.text })),
        events,
        headline: { verifiedClosedByEvidence: b.closedWithEvidence, manuallyReportedResolutionDeclaredBySeller: b.reportedResolvedBySeller, needsActionNow: b.needsActionNow, needsHumanReading: b.needsHumanReading, awaitingNewEvidence: b.awaitingNewEvidence, cannotDetermine: b.cannotDetermine, inProgressAtAmazon: b.inProgressAtAmazon, matchedByInvoiceNumber: b.matchedByInvoiceNumber },
        issues: r.issues.map((i) => ({ key: i.key, family: i.family, subtype: i.subtype, state: i.state, closureBasis: i.outcome, episodes: i.episodes, history: i.history, events: i.events, declaration: i.declaration, lapsedDeclarations: i.lapsedDeclarations, closure: i.closure, card: i.card })),
        coverageNotes: r.coverageNotes,
        rejectedEvents: r.rejectedEvents.map((x) => ({ reason: x.reason, type: x.event.type })),
        notCheckedInThisVersion: r.notCheckedInThisVersion
      };
    },
    async deleteEverything() {
      await adapter.clear();
    },
    // ---- P3: lifecycle. Deletion removes stored records (logical deletion); see docs/LOCAL-DATA-SECURITY-THREAT-MODEL.md for what that does and does not guarantee. ----
    async settings() {
      return { retention: { mode: "KEEP" }, autoLockMinutes: 15, ...await adapter.get("loop:settings") ?? {} };
    },
    async setSettings(next) {
      const cur = await this.settings(), s = { ...cur, ...next }, r = s.retention ?? { mode: "KEEP" };
      if (!["KEEP", "AFTER_DAYS"].includes(r.mode) || r.mode === "AFTER_DAYS" && !(Number.isInteger(r.days) && r.days >= 30 && r.days <= 3650)) throw new Refused(['Retention is either "keep until I delete" or a whole number of days between 30 and 3650.']);
      if (r.mode === "AFTER_DAYS" && r.confirmedAt === void 0) throw new Refused(["Turning on automatic deletion needs your explicit confirmation of what it deletes."]);
      if (!(Number.isInteger(s.autoLockMinutes) && s.autoLockMinutes >= 0 && s.autoLockMinutes <= 240)) throw new Refused(["Auto-lock is 0 (off) to 240 minutes."]);
      await adapter.put("loop:settings", s);
      return s;
    },
    /** What deleting this import would do, computed from the data, nothing is changed. */
    async deletionImpact(importId) {
      const imports = await this.imports(), events = await this.events(), target = imports.find((i) => i.id === importId);
      if (!target) throw new Refused(["That import is not stored."]);
      const pid = await this.profileId(), before = project({ imports, events, sellerProfileId: pid }), rest = imports.filter((i) => i.id !== importId), after = project({ imports: rest, events, sellerProfileId: pid });
      const orphans = orphanedEvents(events, after, rest, pid), ak = new Map(after.issues.map((i) => [i.key, i]));
      const gone = before.issues.filter((i) => !ak.has(i.key)), changed = before.issues.filter((i) => ak.has(i.key) && (ak.get(i.key).state !== i.state || ak.get(i.key).fingerprint !== i.fingerprint));
      const tally = (xs, f) => xs.reduce((m, x) => {
        const k = f(x);
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {});
      return {
        import: { id: target.id, kind: target.kind, fileName: target.fileName, importedAt: target.importedAt, sha256: target.sha256 },
        issuesDisappearing: tally(gone, (i) => i.family),
        issuesChanging: changed.length,
        eventsRemoved: tally(orphans, (e) => e.type),
        eventsKept: events.length - orphans.length,
        importsRemaining: rest.length,
        removes: ["the stored file text and its declarations and mapping profile", "every problem that exists only because of this file (computed, not stored, so nothing else to erase)", "the seller statements attached to those problems (listed above)"],
        keeps: ["all other imports", "seller statements on problems that still exist", "any copy you downloaded (evidence bundle or backup) outside this page"]
      };
    },
    /** Deletes the import, then the seller statements that no longer attach to anything. Needs {confirmed:true}. Import first: an interruption leaves orphaned statements, never a lost import and never a half-deleted file. */
    async deleteImport(importId, { confirmed = false } = {}) {
      if (confirmed !== true) throw new Refused(["Deleting needs your confirmation after you have seen what it removes."]);
      if (!adapter.del) throw new Refused(["This storage cannot delete single records."]);
      const impact = await this.deletionImpact(importId);
      await adapter.del(key("import", importId));
      const imports = await this.imports(), events = await this.events(), pid = await this.profileId(), after = project({ imports, events, sellerProfileId: pid });
      let removed = 0;
      for (const e of orphanedEvents(events, after, imports, pid)) {
        await adapter.del(key("event", e.id));
        removed++;
      }
      return { ...impact, deleted: true, eventsDeleted: removed };
    },
    /** Imports older than the retention days. Only ever acts when the seller turned retention on and confirmed. */
    async retentionPreview(asOf = now()) {
      const s = await this.settings();
      if (s.retention.mode !== "AFTER_DAYS") return { enabled: false, due: [] };
      const cut = Date.parse(asOf) - s.retention.days * 864e5;
      return { enabled: true, days: s.retention.days, due: (await this.imports()).filter((i) => Date.parse(i.importedAt) < cut).map((i) => ({ id: i.id, kind: i.kind, fileName: i.fileName, importedAt: i.importedAt })) };
    },
    async applyRetention(asOf = now()) {
      const p = await this.retentionPreview(asOf), done = [];
      for (const i of p.due) {
        await this.deleteImport(i.id, { confirmed: true });
        done.push(i.id);
      }
      return { enabled: p.enabled, deleted: done };
    }
  };
  return api;
}

// src/history.js
init_buffer_shim();
var memoryAdapter = () => {
  const m = /* @__PURE__ */ new Map();
  return { async put(k, v) {
    m.set(k, v);
  }, async get(k) {
    return m.get(k) ?? null;
  }, async list() {
    return [...m.keys()];
  }, async del(k) {
    m.delete(k);
  }, async clear() {
    m.clear();
  } };
};
var indexedDbAdapter = (name) => {
  if (!name) throw new Error("indexedDbAdapter needs an explicit database name");
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", mode), out = fn(t.objectStore("kv"));
      t.oncomplete = () => {
        db.close();
        res(out.result);
      };
      t.onerror = () => {
        db.close();
        rej(t.error);
      };
    });
  };
  return { put: (k, v) => tx("readwrite", (s) => s.put(v, k)), get: async (k) => await tx("readonly", (s) => s.get(k)) ?? null, list: () => tx("readonly", (s) => s.getAllKeys()), del: (k) => tx("readwrite", (s) => s.delete(k)), clear: () => tx("readwrite", (s) => s.clear()) };
};
var enc = new TextEncoder();
var dec = new TextDecoder();

// src/loop/vault.js
init_buffer_shim();
var VAULT_VERSION = 1;
var ENVELOPE_VERSION = 1;
var META_KEY = "vault:meta";
var MIGRATION_KEY = "vault:migration";
var KDF_ITERATIONS = 6e5;
var VaultLocked = class extends Error {
  constructor() {
    super("The vault is locked.");
    this.code = "VAULT_LOCKED";
  }
};
var VaultError = class extends Error {
  constructor(msg, code = "VAULT_ERROR") {
    super(msg);
    this.code = code;
  }
};
var te = new TextEncoder();
var td = new TextDecoder();
var b64 = (u8) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode(...u8.subarray(i, i + 32768));
  return btoa(s);
};
var unb64 = (s) => {
  try {
    return Uint8Array.from(atob(s), (c2) => c2.charCodeAt(0));
  } catch {
    throw new VaultError("A stored value is not valid base64.", "CORRUPT");
  }
};
var b64u = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var rand = (n) => crypto.getRandomValues(new Uint8Array(n));
var S = () => crypto.subtle;
var kdfBits = async (password, salt, iterations) => S().deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, await S().importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
var recoveryKek = async (recBytes, salt) => S().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("ig/recovery/v1") }, await S().importKey("raw", recBytes, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
var gcm = async (key, iv, aad, data) => new Uint8Array(await S().encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, data));
var ungcm = async (key, iv, aad, data) => new Uint8Array(await S().decrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, data));
var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
var recoveryToText = (u8) => {
  let bits = "", out = "";
  for (const x of u8) bits += x.toString(2).padStart(8, "0");
  bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out.match(/.{1,4}/g).join("-");
};
var recoveryFromText = (t) => {
  const s = String(t).replace(/[\s-]/g, "").toUpperCase();
  let bits = "";
  for (const c2 of s) {
    const i = B32.indexOf(c2);
    if (i < 0) throw new VaultError("The recovery key has a character that is not allowed.", "BAD_RECOVERY");
    bits += i.toString(2).padStart(5, "0");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (bits.length < 256) throw new VaultError("The recovery key is too short.", "BAD_RECOVERY");
  return out;
};
var wrapAad = (vaultId, who) => `ig|v${VAULT_VERSION}|wrap|${vaultId}|${who}`;
var recAad = (vaultId, sk) => `ig|v${ENVELOPE_VERSION}|rec|${vaultId}|${sk}`;
var kindOf2 = (logical) => {
  const i = String(logical).lastIndexOf(":");
  return i > 0 ? String(logical).slice(0, i) : String(logical);
};
function createVault(raw, { iterations = KDF_ITERATIONS, now = () => Date.now(), setTimer = (f, ms3) => setTimeout(f, ms3), clearTimer = (t) => clearTimeout(t), onLock = () => {
} } = {}) {
  let session = null, timer = null, autoMs = 0, vaultIdCache = null;
  const needMeta = async () => {
    const m = await raw.get(META_KEY);
    if (!m) throw new VaultError("No vault exists here yet.", "NO_VAULT");
    if (m.v !== VAULT_VERSION) throw new VaultError("This vault was written by a newer version and cannot be opened here.", "UNSUPPORTED_VERSION");
    return m;
  };
  const openSession = async (rawSecret, vaultId) => {
    const hk = await S().importKey("raw", rawSecret, "HKDF", false, ["deriveKey"]);
    rawSecret.fill(0);
    const derive = (info, alg, usages) => S().deriveKey({ name: "HKDF", hash: "SHA-256", salt: te.encode(vaultId), info: te.encode(info) }, hk, alg, false, usages);
    return { vaultId, encKey: await derive("ig/record/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]), idKey: await derive("ig/id/v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]) };
  };
  const arm = () => {
    if (timer) clearTimer(timer);
    timer = null;
    if (session && autoMs > 0) timer = setTimer(() => api.lock("inactivity"), autoMs);
  };
  const live = () => {
    if (!session) throw new VaultLocked();
    arm();
    return session;
  };
  const storageKey = async (s, logical) => `e${ENVELOPE_VERSION}:${kindOf2(logical)}:${b64u(new Uint8Array(await S().sign("HMAC", s.idKey, te.encode(logical))))}`;
  const seal = async (s, sk, logical, value) => {
    const iv = rand(12);
    return { e: ENVELOPE_VERSION, iv: b64(iv), ct: b64(await gcm(s.encKey, iv, recAad(s.vaultId, sk), te.encode(JSON.stringify({ k: logical, v: value })))) };
  };
  const open = async (s, sk, env) => {
    if (!env || env.e !== ENVELOPE_VERSION || typeof env.iv !== "string" || typeof env.ct !== "string") throw new VaultError("A stored record is not a valid encrypted record.", "CORRUPT");
    let pt;
    try {
      pt = JSON.parse(td.decode(await ungcm(s.encKey, unb64(env.iv), recAad(s.vaultId, sk), unb64(env.ct))));
    } catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError("A stored record failed its integrity check (changed, damaged or moved).", "CORRUPT");
    }
    return pt;
  };
  const isEnv = (k) => String(k).startsWith(`e${ENVELOPE_VERSION}:`);
  const names = /* @__PURE__ */ new Map();
  const api = {
    /** Does a vault exist in this raw store? */
    async exists() {
      return !!await raw.get(META_KEY);
    },
    get unlocked() {
      return !!session;
    },
    /** Creates the vault. Returns the recovery key text ONCE. Nothing about the password or the master secret is stored. */
    async create(password) {
      if (typeof password !== "string" || password.length < 10) throw new VaultError("Choose a password of at least 10 characters.", "WEAK_PASSWORD");
      if (await raw.get(META_KEY)) throw new VaultError("A vault already exists here.", "EXISTS");
      const vaultId = "v-" + b64u(rand(12)), secret = rand(32), recBytes = rand(32), salt = rand(16), recSalt = rand(16), iv1 = rand(12), iv2 = rand(12);
      const kek = await kdfBits(password, salt, iterations), rk = await recoveryKek(recBytes, recSalt);
      const meta = {
        v: VAULT_VERSION,
        vaultId,
        createdAt: new Date(now()).toISOString(),
        kdf: { alg: "PBKDF2-HMAC-SHA256", iterations, salt: b64(salt) },
        pw: { iv: b64(iv1), ct: b64(await gcm(kek, iv1, wrapAad(vaultId, "pw"), secret)) },
        rec: { salt: b64(recSalt), iv: b64(iv2), ct: b64(await gcm(rk, iv2, wrapAad(vaultId, "rec"), secret)) }
      };
      await raw.put(META_KEY, meta);
      session = await openSession(secret, vaultId);
      arm();
      return { recoveryKey: recoveryToText(recBytes), vaultId };
    },
    /** Unlocks with the password (or the recovery key). A wrong secret and a damaged vault give the same answer. */
    async unlock(password) {
      const m = await needMeta();
      let secret;
      try {
        secret = await ungcm(await kdfBits(String(password), unb64(m.kdf.salt), m.kdf.iterations), unb64(m.pw.iv), wrapAad(m.vaultId, "pw"), unb64(m.pw.ct));
      } catch {
        throw new VaultError("That password does not open this vault.", "WRONG_PASSWORD");
      }
      session = await openSession(secret, m.vaultId);
      arm();
      return true;
    },
    async unlockWithRecoveryKey(text) {
      const m = await needMeta();
      let secret;
      try {
        secret = await ungcm(await recoveryKek(recoveryFromText(text), unb64(m.rec.salt)), unb64(m.rec.iv), wrapAad(m.vaultId, "rec"), unb64(m.rec.ct));
      } catch (e) {
        if (e.code === "BAD_RECOVERY") throw e;
        throw new VaultError("That recovery key does not open this vault.", "WRONG_RECOVERY");
      }
      session = await openSession(secret, m.vaultId);
      arm();
      return true;
    },
    /** Sets a new password. Needs the vault unlocked AND the current password (re-checked). Records are not rewritten: only the wrapper changes. */
    async changePassword(current, next) {
      if (!session) throw new VaultLocked();
      if (typeof next !== "string" || next.length < 10) throw new VaultError("Choose a password of at least 10 characters.", "WEAK_PASSWORD");
      const m = await needMeta();
      let secret;
      try {
        secret = await ungcm(await kdfBits(String(current), unb64(m.kdf.salt), m.kdf.iterations), unb64(m.pw.iv), wrapAad(m.vaultId, "pw"), unb64(m.pw.ct));
      } catch {
        throw new VaultError("The current password is not right.", "WRONG_PASSWORD");
      }
      const salt = rand(16), iv = rand(12);
      await raw.put(META_KEY, { ...m, kdf: { ...m.kdf, salt: b64(salt) }, pw: { iv: b64(iv), ct: b64(await gcm(await kdfBits(next, salt, m.kdf.iterations), iv, wrapAad(m.vaultId, "pw"), secret)) } });
      secret.fill(0);
    },
    /** Manual lock, or the inactivity timer. Drops every key reference; nothing is written, so active work is not corrupted (a write in flight finishes or fails closed). */
    lock(reason = "manual") {
      session = null;
      names.clear();
      if (timer) clearTimer(timer);
      timer = null;
      try {
        onLock(reason);
      } catch {
      }
    },
    /** 0 turns the inactivity lock off. Any vault operation counts as activity; the page also calls touch() on user input. */
    setAutoLock(ms3) {
      autoMs = Math.max(0, Number(ms3) || 0);
      arm();
    },
    touch() {
      if (session) arm();
    },
    get autoLockMs() {
      return autoMs;
    },
    /** The adapter the loop store uses. Same put/get/list/clear surface; fails closed while locked or when anything does not verify. */
    adapter: {
      async put(logical, value) {
        const s = live(), sk = await storageKey(s, logical);
        await raw.put(sk, await seal(s, sk, logical, value));
        names.set(sk, logical);
      },
      async get(logical) {
        const s = live(), sk = await storageKey(s, logical), env = await raw.get(sk);
        if (!env) return null;
        const pt = await open(s, sk, env);
        if (pt.k !== logical) throw new VaultError("A stored record does not belong to this key.", "CORRUPT");
        return pt.v;
      },
      async del(logical) {
        const s = live(), sk = await storageKey(s, logical);
        await raw.del(sk);
        names.delete(sk);
      },
      /** Logical keys. Opens each unseen record once (to learn its key) and so also verifies it: a damaged record makes list() fail rather than vanish. */
      async list() {
        const s = live(), out = [];
        for (const sk of (await raw.list()).filter(isEnv)) {
          if (!names.has(sk)) {
            const pt = await open(s, sk, await raw.get(sk));
            names.set(sk, pt.k);
          }
          out.push(names.get(sk));
        }
        return out;
      },
      /** Removes every encrypted record AND the vault metadata (the wrapped master secrets): what is left cannot be opened by anything. Legacy plaintext is handled by the migration module. */
      async clear() {
        live();
        await api.destroy();
      }
    },
    /** Whole-workspace deletion: encrypted records, vault metadata and the migration marker are removed; the session is dropped. */
    async destroy() {
      for (const k of await raw.list()) if (isEnv(k) || k === META_KEY || k === MIGRATION_KEY) await raw.del(k);
      session = null;
      names.clear();
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** Encrypted backup: the wrapped keys plus every record envelope exactly as stored, and a manifest MAC over the sorted list. Nothing readable. */
    async exportBackup() {
      const s = live(), m = await needMeta(), keys = (await raw.list()).filter(isEnv).sort(), records = [];
      for (const k of keys) {
        const env = await raw.get(k);
        await open(s, k, env);
        records.push({ sk: k, env });
      }
      const body = { backupVersion: 1, createdAt: new Date(now()).toISOString(), meta: m, count: records.length };
      const mac = b64(new Uint8Array(await S().sign("HMAC", s.idKey, te.encode(JSON.stringify([body.backupVersion, m.vaultId, records.map((r) => [r.sk, r.env.iv, r.env.ct])])))));
      return { ...body, records, manifestMac: mac };
    },
    /** Restores a backup into an EMPTY raw store after checking it: the password opens it, every record verifies, the count and manifest match. Writes records first and the metadata last, so an interrupted restore leaves no half-vault that opens. */
    async restoreBackup(backup, password, { replace = false } = {}) {
      if (!backup || backup.backupVersion !== 1 || !backup.meta || !Array.isArray(backup.records)) throw new VaultError("This is not an InvoiceGuard backup.", "BAD_BACKUP");
      if (session) throw new VaultError("Lock the current vault before restoring.", "BUSY");
      if (!replace && (await raw.get(META_KEY) || (await raw.list()).some(isEnv))) throw new VaultError("This workspace already holds data. Delete it first, or confirm that the backup replaces it.", "NOT_EMPTY");
      const m = backup.meta;
      if (m.v !== VAULT_VERSION) throw new VaultError("The backup was written by another version.", "UNSUPPORTED_VERSION");
      let secret;
      try {
        secret = await ungcm(await kdfBits(String(password), unb64(m.kdf.salt), m.kdf.iterations), unb64(m.pw.iv), wrapAad(m.vaultId, "pw"), unb64(m.pw.ct));
      } catch {
        throw new VaultError("That password does not open this backup.", "WRONG_PASSWORD");
      }
      const s = await openSession(secret, m.vaultId);
      if (backup.count !== backup.records.length) throw new VaultError("The backup is incomplete: the record count does not match.", "CORRUPT");
      const mac = b64(new Uint8Array(await S().sign("HMAC", s.idKey, te.encode(JSON.stringify([backup.backupVersion, m.vaultId, backup.records.map((r) => [r.sk, r.env?.iv, r.env?.ct])])))));
      if (mac !== backup.manifestMac) throw new VaultError("The backup was changed or is incomplete (the manifest does not match).", "CORRUPT");
      for (const r of backup.records) {
        if (!isEnv(r.sk)) throw new VaultError("The backup holds an unexpected record.", "CORRUPT");
        const pt = await open(s, r.sk, r.env);
        if (r.sk !== await storageKey(s, pt.k)) throw new VaultError("A record in the backup does not belong to its key.", "CORRUPT");
      }
      if (replace) await api.destroy();
      for (const r of backup.records) await raw.put(r.sk, r.env);
      await raw.put(META_KEY, m);
      return { records: backup.records.length, vaultId: m.vaultId };
    },
    /** For migration and tests only: the raw store is exposed read-only through these two calls so callers can see what is persisted. */
    raw
  };
  void vaultIdCache;
  return api;
}

// src/loop/migrate.js
init_buffer_shim();
var canon = (v) => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((y) => [y, x[y]])) : x);
var MigrationError = class extends Error {
  constructor(msg, report) {
    super(msg);
    this.code = "MIGRATION";
    this.report = report;
  }
};
var legacyKeys = async (raw) => (await raw.list()).filter((k) => String(k).startsWith("loop:"));
async function migrateLegacy(vault, { now = () => (/* @__PURE__ */ new Date()).toISOString() } = {}) {
  const raw = vault.raw, keys = await legacyKeys(raw), report = { found: keys.length, migrated: 0, removed: 0, unreadable: [], conflicts: [] };
  if (!keys.length) return report;
  const plain = /* @__PURE__ */ new Map();
  for (const k of keys) {
    const v = await raw.get(k);
    if (v && typeof v === "object" && !Array.isArray(v)) plain.set(k, v);
    else report.unreadable.push(k);
  }
  try {
    await raw.put(MIGRATION_KEY, { state: "copying", found: keys.length, at: now() });
    for (const [k, v] of plain) {
      const have = await vault.adapter.get(k);
      if (have !== null && canon(have) !== canon(v)) {
        report.conflicts.push(k);
        continue;
      }
      if (have === null) await vault.adapter.put(k, v);
    }
    const inVault = new Set(await vault.adapter.list());
    for (const [k, v] of plain) {
      if (report.conflicts.includes(k)) continue;
      if (!inVault.has(k) || canon(await vault.adapter.get(k)) !== canon(v)) throw new MigrationError("A record did not read back identically from the vault. Nothing was removed.", report);
      report.migrated++;
    }
    await raw.put(MIGRATION_KEY, { state: "verified", migrated: report.migrated, at: now() });
    for (const [k] of plain) {
      if (report.conflicts.includes(k)) continue;
      await raw.del(k);
      report.removed++;
    }
    await raw.put(MIGRATION_KEY, { state: report.unreadable.length || report.conflicts.length ? "partial" : "done", migrated: report.migrated, removed: report.removed, unreadable: report.unreadable.length, conflicts: report.conflicts.length, at: now() });
    return report;
  } catch (e) {
    if (e instanceof MigrationError) throw e;
    throw new MigrationError("The migration stopped (" + (e?.name ?? "error") + "). The original data is still in place; run it again.", report);
  }
}

// src/loop/pilot.js
init_buffer_shim();
var isoDay3 = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
var days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
var PILOT_MAX_DAYS = 92;
var c = (id, status, detail) => ({ id, status, detail });
function pilotScope(imports = []) {
  const v = imports.filter((i) => i.kind === "vidr"), keys = new Set(v.map((i) => `${i.declared?.marketplace}|${i.declared?.rangeFrom}|${i.declared?.rangeTo}`));
  const first = [...v].sort((x, y) => String(x.importedAt).localeCompare(String(y.importedAt)))[0];
  return {
    first: first ? { marketplace: first.declared?.marketplace, rangeFrom: first.declared?.rangeFrom, rangeTo: first.declared?.rangeTo } : null,
    distinctPeriods: new Set(v.map((i) => `${i.declared?.rangeFrom}|${i.declared?.rangeTo}`)).size,
    distinctMarketplaces: new Set(v.map((i) => i.declared?.marketplace)).size,
    distinctScopes: keys.size
  };
}
function preflight({ vidrText, vidrDeclared, ledgerText, profile, ledgerDeclared, scope = null, maxDays = PILOT_MAX_DAYS }) {
  const checks = [], vd = vidrDeclared, ld = ledgerDeclared, hasV = vd !== void 0 && vd !== null, hasL = ld !== void 0 && ld !== null;
  if (hasV) {
    const t = parseTable(String(vidrText ?? ""));
    checks.push(t.unsupported || !t.rows?.length ? c("SOURCE_TYPE", "FAIL", "The Amazon file is not a readable tab-delimited table with data rows.") : vd.reportType !== REPORT_TYPE ? c("SOURCE_TYPE", "FAIL", "It was not declared that this is the Amazon VAT invoice data report.") : c("SOURCE_TYPE", "PASS", `Seller-declared as the Amazon VAT invoice report. The table was read (${t.rows.length} data rows); the origin of the file cannot be verified by this tool.`));
    checks.push(vd.options === "ALL" ? c("REPORT_OPTIONS", "PASS", "Declared by the seller: all statuses.") : c("REPORT_OPTIONS", "FAIL", "The pilot needs the all-status report; pending-only or undeclared hides problems."));
    if (!isoDay3(vd.rangeFrom) || !isoDay3(vd.rangeTo) || vd.rangeFrom > vd.rangeTo) checks.push(c("PERIOD", "FAIL", "The Amazon report period is missing or reversed."));
    else if (days(vd.rangeFrom, vd.rangeTo) > maxDays) checks.push(c("PERIOD", "FAIL", `The period is ${days(vd.rangeFrom, vd.rangeTo)} days; the pilot is bounded to ${maxDays}.`));
    else checks.push(c("PERIOD", "PASS", `Declared period of ${days(vd.rangeFrom, vd.rangeTo)} days.`));
    checks.push(vd.createdAfterUploadConfirmed === true && vd.createdAt ? c("REPORT_FRESH", "PASS", "Declared as created after the uploads, with its creation time.") : c("REPORT_FRESH", "WARN", "Not declared as created after the uploads; closure by evidence will not be possible for this file."));
  }
  if (hasL) {
    checks.push(ld.complete === true ? c("LEDGER_COMPLETE", "PASS", "Declared by the seller as a complete export of the period (not verified by this tool).") : c("LEDGER_COMPLETE", "FAIL", "The accounting export is not declared complete; missing-invoice findings would not be reliable."));
    checks.push(ld.amazonScope?.mode === "UNKNOWN" ? c("AMAZON_SCOPE", "WARN", "It is not declared which accounting documents are Amazon sales.") : ["ALL", "CHANNEL"].includes(ld.amazonScope?.mode) ? c("AMAZON_SCOPE", "PASS", `Amazon scope declared (${ld.amazonScope.mode}).`) : c("AMAZON_SCOPE", "FAIL", "The Amazon scope of the accounting export is missing."));
    if (!isoDay3(ld.periodFrom) || !isoDay3(ld.periodTo) || ld.periodFrom > ld.periodTo) checks.push(c("LEDGER_PERIOD", "FAIL", "The accounting export period is missing or reversed."));
  }
  if (hasV && hasL) {
    checks.push(isoDay3(ld.periodFrom) && isoDay3(ld.periodTo) && isoDay3(vd.rangeFrom) && isoDay3(vd.rangeTo) && ld.periodFrom <= vd.rangeFrom && ld.periodTo >= vd.rangeTo ? c("PERIOD_COVERAGE", "PASS", "The accounting export period covers the Amazon report period.") : c("PERIOD_COVERAGE", "FAIL", "The accounting export period is missing or does not cover the Amazon report period."));
    checks.push(vd.marketplace && vd.marketplace === ld.marketplace ? c("MARKETPLACE", "PASS", "Both files are declared for the same marketplace.") : c("MARKETPLACE", "FAIL", "The marketplace is missing or differs between the two files."));
  }
  const mk = hasV ? vd.marketplace : ld?.marketplace, from = hasV ? vd.rangeFrom : ld?.periodFrom, to = hasV ? vd.rangeTo : ld?.periodTo;
  if (scope?.first) checks.push(mk === scope.first.marketplace && (hasV ? from === scope.first.rangeFrom && to === scope.first.rangeTo : ld.periodFrom <= scope.first.rangeFrom && ld.periodTo >= scope.first.rangeTo) ? c("PILOT_SCOPE", "PASS", "Same marketplace and period as the files already stored for this pilot.") : c("PILOT_SCOPE", "FAIL", "This file is for a different marketplace or period than the files already stored. One pilot is one marketplace and one period: delete the stored files first, or use a separate vault."));
  if (hasV) {
    const vp = vidrDoorProblems(String(vidrText ?? ""), vd);
    if (vp.length) checks.push(c("COMPATIBILITY", "FAIL", `${vp.length} requirement(s) of the import door are not met.`));
  }
  if (hasL) {
    const lp = ledgerDoorProblems(String(ledgerText ?? ""), profile, ld);
    checks.push(lp.length ? c("COMPATIBILITY", "FAIL", `${lp.length} requirement(s) of the import door are not met.`) : c("COMPATIBILITY", "PASS", "The accounting export passes the import door."));
    if (!lp.length) {
      const r = readLedger(String(ledgerText ?? ""), profile, {});
      const n = r.documents?.length ?? 0, rej = r.rejected?.length ?? 0;
      checks.push(!r.ok ? c("LEDGER_ROWS", "FAIL", "The accounting export could not be read with this column mapping.") : n + rej > LEDGER_MAX_ROWS ? c("LEDGER_ROWS", "FAIL", `More than ${LEDGER_MAX_ROWS} rows.`) : rej ? c("LEDGER_ROWS", "WARN", `${n} documents read, ${rej} rows rejected by the parser.`) : c("LEDGER_ROWS", "PASS", `${n} documents read, 0 rejected.`));
    }
  }
  if (!(hasV && hasL)) checks.push(c("PAIR", "NOTE", "Only one of the two files is being checked now. The checks that compare both files run when the second file is loaded."));
  return { ready: !checks.some((x) => x.status === "FAIL"), checks, warnings: checks.filter((x) => x.status === "WARN").map((x) => x.id), note: "Counts and fixed wording only. Everything about the source is declared by the seller, not verified." };
}
var RANK = { PASS: 0, NOTE: 0, WARN: 1, FAIL: 2 };
function mergeChecks(lists) {
  const by = /* @__PURE__ */ new Map();
  for (const ch of lists.flat()) {
    const e = by.get(ch.id);
    if (!e) by.set(ch.id, { worst: ch, n: 1, bad: ch.status === "FAIL" || ch.status === "WARN" ? 1 : 0 });
    else {
      e.n++;
      if (ch.status === "FAIL" || ch.status === "WARN") e.bad++;
      if (RANK[ch.status] > RANK[e.worst.status]) e.worst = ch;
    }
  }
  return [...by.values()].map(({ worst, n, bad }) => n > 1 && bad ? { ...worst, detail: `${worst.detail} (${bad} of ${n} checks)` } : worst);
}
var finish = (checks) => ({ ready: !checks.some((x) => x.status === "FAIL"), checks, warnings: checks.filter((x) => x.status === "WARN").map((x) => x.id), note: "Counts and fixed wording only. Everything about the source is declared by the seller, not verified." });
var side = (i) => i.kind === "vidr" ? { vidrText: i.text, vidrDeclared: i.declared } : { ledgerText: i.text, profile: i.profile, ledgerDeclared: i.declared };
function preflightStored(imports) {
  const v = imports.filter((i) => i.kind === "vidr"), l = imports.filter((i) => i.kind === "ledger"), sc = pilotScope(imports), lists = [];
  lists.push([c("VIDR_PRESENT", v.length ? "PASS" : "FAIL", v.length ? `${v.length} Amazon report(s) stored.` : "No Amazon report is stored."), c("LEDGER_PRESENT", l.length ? "PASS" : "FAIL", l.length ? `${l.length} accounting export(s) stored.` : "No accounting export is stored.")]);
  for (const i of imports) lists.push(preflight({ ...side(i), scope: sc }).checks.filter((x) => x.id !== "PAIR"));
  for (const a of v) for (const b of l) lists.push(preflight({ ...side(a), ...side(b), scope: sc }).checks.filter((x) => ["PERIOD_COVERAGE", "MARKETPLACE"].includes(x.id)));
  if (sc.distinctScopes > 1) lists.push([c("PILOT_SCOPE", "FAIL", `The stored Amazon reports cover ${sc.distinctScopes} different marketplace/period combinations. One pilot is one marketplace and one period.`)]);
  return finish(mergeChecks(lists));
}
function preflightPending(kind, pending, imports) {
  const sc = pilotScope(imports), opp = imports.filter((i) => i.kind === (kind === "vidr" ? "ledger" : "vidr")), mine = kind === "vidr" ? { vidrText: pending.text, vidrDeclared: pending.declared } : { ledgerText: pending.text, profile: pending.profile, ledgerDeclared: pending.declared };
  const lists = [preflight({ ...mine, scope: sc }).checks.filter((x) => !(opp.length && x.id === "PAIR"))];
  for (const o of opp) lists.push(preflight({ ...mine, ...side(o), scope: sc }).checks.filter((x) => ["PERIOD_COVERAGE", "MARKETPLACE"].includes(x.id)));
  if (kind === "vidr" && !imports.some((i) => i.kind === "vidr")) for (const o of opp) lists.push(preflight({ ...side(o), scope: { first: { marketplace: pending.declared?.marketplace, rangeFrom: pending.declared?.rangeFrom, rangeTo: pending.declared?.rangeTo } } }).checks.filter((x) => x.id === "PILOT_SCOPE"));
  return finish(mergeChecks(lists));
}
var ADJUDICATIONS = Object.freeze(["CONFIRMED_REAL", "FALSE_POSITIVE", "COULD_NOT_CONFIRM"]);
var num = (v) => v === void 0 || v === null || v === "" ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : NaN;
var KEY = "loop:pilot";
function createPilotRecord(adapter, { now = () => (/* @__PURE__ */ new Date()).toISOString() } = {}) {
  const read = async () => await adapter.get(KEY) ?? { v: 1, times: {}, adjudications: {}, missedBySeller: 0 };
  const save = (r) => adapter.put(KEY, r);
  return {
    read,
    async setTimes({ manualMinutesBefore, toolMinutesWith }) {
      const a = num(manualMinutesBefore), b = num(toolMinutesWith);
      if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) throw new Error("Both times are required: enter a number of minutes, zero or more, for each. An empty box is not zero.");
      const r = await read();
      r.times = { manualMinutesBefore: a, toolMinutesWith: b, basis: "SELLER_REPORTED", at: now() };
      await save(r);
    },
    async adjudicate(issueKey2, outcome) {
      if (!ADJUDICATIONS.includes(outcome)) throw new Error("Unknown outcome.");
      if (!/^[0-9a-f]{64}$/.test(String(issueKey2))) throw new Error("Unknown finding.");
      const r = await read();
      r.adjudications[issueKey2] = outcome;
      await save(r);
    },
    async setMissed(n) {
      const m = num(n);
      if (m === null || Number.isNaN(m) || !Number.isInteger(m)) throw new Error("Missed findings must be a whole number, zero or more.");
      const r = await read();
      r.missedBySeller = m;
      await save(r);
    }
  };
}
var STR_OK = /* @__PURE__ */ new Set(["SELLER_REPORTED", "MACHINE_VERIFIED_BY_LATER_FILE", "aggregate-only", "pilot-1"]);
function assertAggregateOnly(o, allowed = /* @__PURE__ */ new Set()) {
  const walk = (x, path) => {
    if (x === null || typeof x === "number" || typeof x === "boolean") return;
    if (typeof x === "string") {
      if (!(STR_OK.has(x) || allowed.has(x))) throw new Error(`Aggregate export refused: free text at ${path}`);
      return;
    }
    if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${path}[${i}]`));
    for (const [k, v] of Object.entries(x)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new Error(`Aggregate export refused: odd key at ${path}`);
      walk(v, `${path}.${k}`);
    }
  };
  walk(o, "$");
  return true;
}
function aggregateMetrics({ projection, record, imports = [] }) {
  const sc = pilotScope(imports);
  if (sc.distinctScopes > 1) throw new Error("The stored files cover more than one marketplace or period, so they are not one pilot. Delete the extra files before creating a pilot result.");
  const pf = preflightStored(imports);
  if (!pf.ready) throw new Error("The stored files do not pass the pilot preflight, so no pilot aggregate is produced. Failed checks: " + pf.checks.filter((x) => x.status === "FAIL").map((x) => x.id).join(", ") + ".");
  const issues = projection.issues, adj = record.adjudications ?? {}, keys = new Set(issues.map((i) => i.key));
  const by = (f) => issues.reduce((m, i) => {
    const k = f(i);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  const mine = Object.entries(adj).filter(([k]) => keys.has(k)).map(([, v]) => v), n = (v) => mine.filter((x) => x === v).length;
  const real = n("CONFIRMED_REAL"), fp = n("FALSE_POSITIVE"), cnc = n("COULD_NOT_CONFIRM"), judged = real + fp;
  const confirmedGaps = issues.filter((i) => adj[i.key] === "CONFIRMED_REAL" && ["BOOKS_GAP", "UNMATCHED_DOCUMENT"].includes(i.family)).length;
  const t = record.times ?? {};
  const out = {
    pilotExportVersion: "pilot-1",
    kind: "aggregate-only",
    findings: { total: issues.length, byFamily: by((i) => i.family), byState: by((i) => i.state) },
    sellerAdjudication: {
      basis: "SELLER_REPORTED",
      confirmedReal: real,
      falsePositive: fp,
      couldNotConfirm: cnc,
      notYetReviewed: issues.length - mine.length,
      precisionAmongReviewed: judged ? { value: Math.round(real / judged * 1e3) / 1e3, reviewed: judged } : null,
      confirmedMissingInvoiceOrAccountingGap: confirmedGaps,
      missedBySeller: record.missedBySeller ?? 0,
      recallComputable: false
    },
    cannotDetermine: (projection.buckets?.cannotDetermine ?? 0) + (projection.buckets?.needsHumanReading ?? 0),
    resolvedBySubsequentImports: { basis: "MACHINE_VERIFIED_BY_LATER_FILE", count: projection.buckets?.closedWithEvidence ?? 0 },
    sellerReportedResolved: { basis: "SELLER_REPORTED", count: projection.buckets?.reportedResolvedBySeller ?? 0 },
    time: t.basis && Number.isFinite(t.manualMinutesBefore) && Number.isFinite(t.toolMinutesWith) ? { basis: "SELLER_REPORTED", manualMinutesBefore: t.manualMinutesBefore, toolMinutesWith: t.toolMinutesWith, minutesSaved: Math.round((t.manualMinutesBefore - t.toolMinutesWith) * 10) / 10 } : null,
    imports: { amazonReports: imports.filter((i) => i.kind === "vidr").length, accountingExports: imports.filter((i) => i.kind === "ledger").length },
    pilotScope: { distinctMarketplaces: sc.distinctMarketplaces, distinctPeriods: sc.distinctPeriods, periodDays: sc.first && isoDay3(sc.first.rangeFrom) && isoDay3(sc.first.rangeTo) ? days(sc.first.rangeFrom, sc.first.rangeTo) : null },
    preflightOnThisData: { ready: pf.ready, fail: pf.checks.filter((x) => x.status === "FAIL").length, warn: pf.checks.filter((x) => x.status === "WARN").length }
  };
  const allowed = /* @__PURE__ */ new Set([...Object.keys(out.findings.byFamily), ...Object.keys(out.findings.byState)]);
  assertAggregateOnly(out, allowed);
  return out;
}
export {
  ADJUDICATIONS,
  FIELDS,
  Refused,
  VaultError,
  VaultLocked,
  aggregateMetrics,
  createLoopStore,
  createPilotRecord,
  createVault,
  detectLedgerMapping,
  indexedDbAdapter,
  legacyKeys,
  memoryAdapter,
  migrateLegacy,
  pilotScope,
  preflight,
  preflightPending,
  preflightStored
};
