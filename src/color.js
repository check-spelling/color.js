import * as util from "./util.js";
import Hooks from "./hooks.js";

const ε = .000005;
const hasDOM = typeof document !== "undefined";

export default class Color {
	// Signatures:
	// new Color(stringToParse)
	// new Color(otherColor)
	// new Color(coords, alpha) // defaults to sRGB
	// new Color(CSS variable [, root])
	constructor (...args) {
		let str, color;

		// new Color(color)
		// new Color({spaced, coords})
		if (args[0] && typeof args[0] === "object" && args[0].spaceId && args[0].coords) {
			color = args[0];
		}
		else if (util.isString(args[0])) {
			// new Color("--foo" [, root])
			if (hasDOM && args[0].indexOf("--") === 0) {
				// CSS variable
				let root = arguments[1] && arguments[1].nodeType === 1? arguments[1] : document.documentElement;
				str = getComputedStyle(root).getPropertyValue(arguments[0]);
			}
			 // new Color(string)
			else if (args.length === 1) {
				str = args[0];
			}

			if (str) {
				color = Color.parse(str);

				if (!color) {
					throw new TypeError(`Cannot parse "${str}" as a color`);
				}
			}
		}

		if (color) {
			this.spaceId = color.spaceId;
			this.coords = color.coords;
			this.alpha = color.alpha;
		}
		else { // default signature new Color([ColorSpace,] array [, alpha])
			let spaceId, coords, alpha;

			if (Array.isArray(args[0])) {
				// No color space provided, default to sRGB
				[spaceId, coords, alpha] = ["sRGB", ...args];
			}
			else {
				[spaceId, coords, alpha] = args;
			}

			this.spaceId = spaceId || "sRGB";
			this.coords = coords || [0, 0, 0];
			this.alpha = alpha;
		}

		this.alpha = this.alpha < 1? this.alpha : 1; // this also deals with NaN etc
	}

	get space () {
		return Color.spaces[this.spaceId];
	}

	set space (value) {
		// Setting spaceId works with color space objects too
		return this.spaceId = value;
	}

	get spaceId () {
		return this._spaceId;
	}

	// Handle dynamic changes of color space
	set spaceId (id) {
		let newSpace = Color.space(id);

		id = newSpace.id;

		if (this.space && newSpace && this.space !== newSpace) {
			// We’re not setting this for the first time, need to:
			// a) Convert coords
			this.coords = this[id];

			// b) Remove instance properties from previous color space
			for (let prop in this.space.instance) {
				if (this.hasOwnProperty(prop)) {
					delete this[prop];
				}
			}
		}

		this._spaceId = id;

		// Add new instance properties from new color space
		util.extend(this, this.space.instance);
	}

	get white () {
		return this.space.white || Color.whites.D50;
	}

	// Set properties and return current instance
	set (prop, value) {
		if (arguments.length === 1 && util.type(arguments[0]) === "object") {
			// Argument is an object literal
			let object = arguments[0];
			for (let p in object) {
				this.set(p, object[p]);
			}
		}
		else {
			if (typeof value === "function") {
				let current = util.value(this, prop);

				util.value(this, prop, value.call(this, current));
			}
			else {
				util.value(this, prop, value);
			}

		}

		return this;
	}

	lighten(amount = .2, {inPlace} = {}) {
		let ret = inPlace? this : new Color(this);
		return ret.set("lightness", c => c * (1 + amount));
	}

	darken(amount = .2, {inPlace} = {}) {
		let ret = inPlace? this : new Color(this);
		return ret.set("lightness", c => c * (1 - amount));
	}

	// 1976 DeltaE. 2.3 is the JND
	deltaE (color) {
		color = Color.get(color);
		let lab1 = this.lab;
		let lab2 = color.lab;
		return Math.sqrt([0, 1, 2].reduce((a, i) => {
			if (isNaN(lab1[i]) || isNaN(lab2[i])) {
				return 0;
			}

			return a + (lab2[i] - lab1[i]) ** 2;
		}, 0));
	}

	luminance () {
		return this.xyz.Y / this.white[1];
	}

	contrast (color) {
		return (this.luminance + .05) / (color.luminance + .05);
	}

	// Get formatted coords
	getCoords ({inGamut, precision = Color.defaults.precision} = {}) {
		let coords = this.coords;

		if (inGamut === true && !this.inGamut()) {
			coords = this.toGamut().coords;
		}

		if (precision !== undefined) {
			let bounds = this.space.coords? Object.values(this.space.coords) : [];

			coords = coords.map((n, i) => util.toPrecision(n, precision, bounds[i]));

		}

		return coords;
	}

	/**
	 * @return {Boolean} Is the color in gamut?
	 */
	inGamut ({space = this.space} = {}) {
		space = Color.space(space);
		return Color.inGamut(space, this[space.id]);
	}

	static inGamut (space, coords) {
		space = Color.space(space);

		if (space.inGamut) {
			return space.inGamut(coords);
		}
		else {
			if (!space.coords) {
				return true;
			}

			// No color-space specific inGamut() function, just check if coords are within reference range
			let bounds = Object.values(space.coords);

			return coords.every((c, i) => {
				let [min, max] = bounds[i];

				return (min === undefined || c >= min - ε)
				    && (max === undefined || c <= max + ε);
			});
		}
	}

	/**
	 * Force coordinates in gamut of a certain color space and return the result
	 * @param {Object} options
	 * @param {string} options.method - How to force into gamut.
	 *        If "clip", coordinates are just clipped to their reference range.
	 *        If in the form [colorSpaceId].[coordName], that coordinate is reduced
	 *        until the color is in gamut. Please note that this may produce nonsensical
	 *        results for certain coordinates (e.g. hue) or infinite loops if reducing the coordinate never brings the color in gamut.
	 * @param {ColorSpace|string} options.space - The space whose gamut we want to map to
	 * @param {boolean} options.inPlace - If true, modify the current color, otherwise return a new one.
	 */
	toGamut ({method = Color.defaults.gamutMapping, space = this.space, inPlace} = {}) {
		space = Color.space(space);

		if (this.inGamut(space)) {
			return this;
		}

		let coords = Color.convert(this.coords, this.space, space);

		if (method.indexOf(".") > 0) {
			// Reduce a coordinate of a certain color space until the color is in gamut
			let [mapSpace, coordName] = util.parseCoord(method);

			let min = mapSpace.coords[coordName][0];
			let i = Object.keys(mapSpace.coords).indexOf(coordName);

			// arr.slice() clones the coords so we can tweak without affecting the original color
			let mapCoords = this[mapSpace.id].slice();

			let low = min;
			let high = mapCoords[i];

			mapCoords[i] /= 2;

			while (high - low > ε) {
				coords = Color.convert(mapCoords, mapSpace, space);

				if (Color.inGamut(space, coords)) {
					low = mapCoords[i];
				}
				else {
					high = mapCoords[i];
				}

				mapCoords[i] = (high + low) / 2;
			}
		}

		if (method === "clip" // Dumb coord clipping
		    // finish off smarter gamut mapping with clip to get rid of ε, see #17
		    || !Color.inGamut(space, coords)
		) {

			let bounds = Object.values(space.coords);

			coords = coords.map((c, i) => {
				let [min, max] = bounds[i];

				if (min !== undefined) {
					c = Math.max(min, c);
				}

				if (max !== undefined) {
					c = Math.min(c, max);
				}

				return c;
			});
		}

		if (inPlace) {
			this.coords = coords;
			return this;
		}
		else {
			return new Color(this.spaceId, coords, this.alpha);
		}
	}

	/**
	 * Convert to color space and return a new color
	 * @param {Object|string} space - Color space object or id
	 * @param {Object} options
	 * @param {boolean} options.inGamut - Whether to force resulting color in gamut
	 * @returns {Color}
	 */
	to (space, {inGamut} = {}) {
		let id = space;

		if (!util.isString(space)) {
			id = space.id;
		}

		let color = new Color(id, this[id], this.alpha);

		if (inGamut) {
			color.inGamut({inPlace: true});
		}

		return color;
	}

	toJSON () {
		return {
			spaceId: this.spaceId,
			coords: this.coords,
			alpha: this.alpha
		};
	}

	/**
	 * Generic toString() method, outputs a color(spaceId ...coords) function
	 * @param {Object} options
	 * @param {number} options.precision - Significant digits
	 * @param {boolean} options.commas - Whether to use commas to separate arguments or spaces (and a slash for alpha) [default: false]
	 * @param {Function|String|Array} options.format - If function, maps all coordinates. Keywords tap to colorspace-specific formats (e.g. "hex")
	 * @param {boolean} options.inGamut - Adjust coordinates to fit in gamut first? [default: false]
	 * @param {string} options.name - Function name [default: color]
	 */
	toString ({precision = Color.defaults.precision, format, commas, inGamut, name = "color"} = {}) {
		let strAlpha = this.alpha < 1? ` ${commas? "," : "/"} ${this.alpha}` : "";

		let coords = this.getCoords({inGamut, precision});

		// Convert NaN to zeros to have a chance at a valid CSS color
		// Also convert -0 to 0
		coords = coords.map(c => c? c : 0);

		if (util.isString(format)) {
			if (format === "%") {
				let options = {style: "percent"};

				if (Number.isInteger(precision) && precision <= 21) {
					options.maximumSignificantDigits = precision;
				}

				format = c => c.toLocaleString("en-US",  options);
			}
		}

		if (typeof format === "function") {
			coords = coords.map(format);
		}

		let args = [...coords];

		if (name === "color") {
			// If output is a color() function, add colorspace id as first argument
			args.unshift(this.space? this.space.cssId || this.space.id : "XYZ");
		}

		return `${name}(${args.join(commas? ", " : " ")}${strAlpha})`;
	}

	equals (color) {
		color = Color.get(color);
		return this.spaceId === color.spaceId
		       && this.alpha === color.alpha
		       && this.coords.every((c, i) => c === color.coords[i]);
	}

	// Adapt XYZ from white point W1 to W2
	static chromaticAdaptation (W1, W2, XYZ) {
		W1 = W1 || Color.whites.D50;
		W2 = W2 || Color.whites.D50;

		if (W1 === W2) {
			return XYZ;
		}

		let M;

		if (W1 === Color.whites.D65 && W2 === Color.whites.D50) {
			M = [
				[ 1.0478112,  0.0228866, -0.0501270],
				[ 0.0295424,  0.9904844, -0.0170491],
				[-0.0092345,  0.0150436,  0.7521316]
			];
		}
		else if (W1 === Color.whites.D50 && W2 === Color.whites.D65) {
			M = [
				[ 0.9555766, -0.0230393,  0.0631636],
				[-0.0282895,  1.0099416,  0.0210077],
				[ 0.0122982, -0.0204830,  1.3299098]
			];
		}

		if (M) {
			return util.multiplyMatrices(M, XYZ);
		}
		else {
			throw new TypeError("Only white points D50 and D65 supported for now.");
		}
	}

	// CSS color to Color object
	static parse (str) {
		let parsed = Color.parseFunction(str);

		let env = {str, parsed};
		Color.hooks.run("parse-start", env);

		if (env.color) {
			return env.color;
		}

		let isRGB = parsed && parsed.name.indexOf("rgb") === 0;

		// Try colorspace-specific parsing
		for (let space of Object.values(Color.spaces)) {
			if (space.parse) {
				let color = space.parse(str, parsed);

				if (color) {
					return color;
				}
			}
		}

		if ((!parsed || !isRGB) && hasDOM && document.head) {
			// Use browser to parse when a DOM is available
			// this is how we parse #hex or color names, or RGB transformations like hsl()
			let previousColor = document.head.style.color;
			document.head.style.color = "";
			document.head.style.color = str;

			if (document.head.style.color !== previousColor) {
				let computed = getComputedStyle(document.head).color;
				document.head.style.color = previousColor;

				if (computed) {
					str = computed;
					parsed = Color.parseFunction(computed);
				}
			}
		}

		// parsed might have changed, recalculate
		isRGB = parsed && parsed.name.indexOf("rgb") === 0;

		if (parsed) {
			// It's a function
			if (isRGB) {
				let args = parsed.args.map((c, i) => i < 3 && !c.percentage? c / 255 : +c);

				return {
					spaceId: "srgb",
					coords: args.slice(0, 3),
					alpha: args[3]
				};
			}
			else if (parsed.name === "color") {
				let spaceId = parsed.args.shift();
				let space = Object.values(Color.spaces).find(space => (space.cssId || space.id) === spaceId);

				if (space) {
					// From https://drafts.csswg.org/css-color-4/#color-function
					// If more <number>s or <percentage>s are provided than parameters that the colorspace takes, the excess <number>s at the end are ignored.
					// If less <number>s or <percentage>s are provided than parameters that the colorspace takes, the missing parameters default to 0. (This is particularly convenient for multichannel printers where the additional inks are spot colors or varnishes that most colors on the page won’t use.)
					let argCount = Object.keys(space.coords).length;
					let alpha = parsed.rawArgs.indexOf("/") > 0? parsed.args.pop() : 1;
					let coords = Array(argCount).fill(0);
					coords.forEach((_, i) => coords[i] = parsed.args[i] || 0);

					return {spaceId: space.id, coords, alpha};
				}
				else {
					throw new TypeError(`Color space ${spaceId} not found. Missing a plugin?`);
				}
			}
		}
	}

	/**
	 * Parse a CSS function, regardless of its name and arguments
	 * @param String str String to parse
	 * @return Object An object with {name, args, rawArgs}
	 */
	static parseFunction (str) {
		if (!str) {
			return;
		}

		str = str.trim();

		const isFunctionRegex = /^([a-z]+)\((.+?)\)$/i;
		const isNumberRegex = /^-?[\d.]+$/;
		let parts = str.match(isFunctionRegex);

		if (parts) {
			// It is a function, parse args
			let args = parts[2].match(/([-\w.]+(?:%|deg)?)/g);

			args = args.map(arg => {
				if (/%$/.test(arg)) {
					// Convert percentages to 0-1 numbers
					let n = new Number(+arg.slice(0, -1) / 100);
					n.percentage = true;
					return n;
				}
				else if (/deg$/.test(arg)) {
					// Drop deg from degrees and convert to number
					let n = new Number(+arg.slice(0, -3));
					n.deg = true;
					return n;
				}
				else if (isNumberRegex.test(arg)) {
					// Convert numerical args to numbers
					return +arg;
				}

				// Return everything else as-is
				return arg;
			});

			return {
				name: parts[1],
				rawArgs: parts[2],
				// An argument could be (as of css-color-4):
				// a number, percentage, degrees (hue), ident (in color())
				args
			};
		}
	}

	// One-off convert between color spaces
	static convert (coords, fromSpace, toSpace) {
		fromSpace = Color.space(fromSpace);
		toSpace = Color.space(toSpace);

		let fromId = fromSpace.id;

		if (fromSpace === toSpace) {
			// Same space, no change needed
			return coords;
		}

		// Do we have a more specific conversion function?
		// Avoids round-tripping to & from XYZ
		let Id = util.capitalize(fromId);

		if (("from" + Id) in toSpace) {
			// No white point adaptation, we assume the custom function takes care of it
			return space["from" + Id](coords);
		}

		let XYZ = fromSpace.toXYZ(coords);

		if (toSpace.white !== fromSpace.white) {
			// Different white point, perform white point adaptation
			XYZ = Color.chromaticAdaptation(fromSpace.white, toSpace.white, XYZ);
		}

		return toSpace.fromXYZ(XYZ);
	}

	/**
	 * Get a color from the argument passed
	 * Basically gets us the same result as new Color(color) but doesn't clone an existing color object
	 */
	static get (color, ...args) {
		if (color instanceof Color) {
			return color;
		}

		return new Color(color, ...args);
	}

	/**
	 * Return a color space object from an id or color space object
	 * Mainly used internally, so that functions can easily accept either
	 */
	static space (space) {
		let type = util.type(space);

		if (type === "string") {
			// It's a color space id
			let ret = Color.spaces[space.toLowerCase()];

			if (!ret) {
				throw new TypeError(`No color space found with id = "${id}"`);
			}

			return ret;
		}
		else if (space && type === "object") {
			return space;
		}

		throw new TypeError(`${space} is not a valid color space`);
	}

	// Define a new color space
	static defineSpace ({id, inherits}) {
		let space = Color.spaces[id] = arguments[0];

		if (inherits) {
			const except = ["id", "parse", "instance", "properties"];
			let parent = Color.spaces[inherits];

			for (let prop in parent) {
				if (!except.includes(prop) && !(prop in space)) {
					util.copyDescriptor(space, parent, prop);
				}
			}
		}

		let coords = space.coords;

		if (space.properties) {
			util.extend(Color.prototype, space.properties);
		}

		if (!space.fromXYZ && !space.toXYZ) {
			// Using a different connection space, define from/to XYZ functions based on that

			// What are we using as a connection space?
			for (let prop in space) {
				if (typeof space[prop] === "function") {
					// Is the name of the form fromXxx or toXxx?
					let Id = (prop.match(/^(?:from|to)([A-Z][a-zA-Z]+$)/) || [])[1];

					if (Id && ("from" + Id) in space && ("to" + Id) in space) {
						// This is a conversion function AND we have both from & to!
						let space = Color.spaces[Id.toLowerCase()];

						if (space) {
							// var used intentionally
							var connectionSpace = space;
							var fromConnection = "from" + Id;
							var toConnection = "to" + Id;
							break;
						}
					}
				}
			}

			if (connectionSpace) {
				// Define from/to XYZ functions based on the connection space

				if (!connectionSpace.toXYZ || !connectionSpace.fromXYZ) {
					throw new ReferenceError(`Connection space ${connectionSpace.name} for ${space.name} has no toXYZ()/fromXYZ() functions.`);
				}

				Object.assign(space, {
					// ISSUE do we need white point adaptation here?
					fromXYZ(XYZ) {
						let newCoords = connectionSpace.fromXYZ(XYZ);
						return this[fromConnection](newCoords);
					},
					toXYZ(coords) {
						let newCoords = this[toConnection](coords);
						return connectionSpace.toXYZ(newCoords);
					}
				});
			}
			else {
				throw new ReferenceError(`No connection space found for ${space.name}.`);
			}
		}

		let coordNames = Object.keys(coords);

		// Define getters and setters for color[spaceId]
		// e.g. color.lch on *any* color gives us the lch coords
		Object.defineProperty(Color.prototype, id, {
			// Convert coords to coords in another colorspace and return them
			// Source colorspace: this.spaceId
			// Target colorspace: id
			get () {
				let ret = Color.convert(this.coords, this.spaceId, id);

				if (!self.Proxy) {
					return ret;
				}

				// Enable color.spaceId.coordName syntax
				return new Proxy(ret, {
					has: (obj, property) => {
						return coordNames.includes(property) || Reflect.has(obj, property);
					},
					get: (obj, property, receiver) => {
						let i = coordNames.indexOf(property);

						if (i > -1) {
							return obj[i];
						}

						return Reflect.get(obj, property, receiver);
					},
					set: (obj, property, value, receiver) => {
						let i = coordNames.indexOf(property);

						if (property > -1) { // Is property a numerical index?
							i = property; // next if will take care of modifying the color
						}

						if (i > -1) {
							obj[i] = value;

							// Update color.coords
							this.coords = Color.convert(obj, id, this.spaceId);

							return true;
						}

						return Reflect.set(obj, property, value, receiver);
					},

				});
			},
			// Convert coords in another colorspace to internal coords and set them
			// Target colorspace: this.spaceId
			// Source colorspace: id
			set (coords) {
				this.coords = Color.convert(coords, id, this.spaceId);
			},
			configurable: true,
			enumerable: true
		});

		return space;
	}

	// Define a shortcut property, e.g. color.lightness instead of color.lch.lightness
	// Shorcut is looked up on Color.shortcuts at calling time
	// If `long` is provided, it's added to Color.shortcuts as well, otherwise it's assumed to be already there
	static defineShortcut(prop, obj = Color.prototype, long) {
		if (long) {
			Color.shortcuts[prop] = long;
		}

		Object.defineProperty(obj, prop, {
			get () {
				return util.value(this, Color.shortcuts[prop]);
			},
			set (value) {
				return util.value(this, Color.shortcuts[prop], value);
			},
			configurable: true,
			enumerable: true
		});
	}

	// Define static versions of all instance methods
	static statify(names = []) {
		names = names || Object.getOwnPropertyNames(Color.prototype);

		for (let prop of Object.getOwnPropertyNames(Color.prototype)) {
			let descriptor = Object.getOwnPropertyDescriptor(Color.prototype, prop);

			if (descriptor.get || descriptor.set) {
				continue; // avoid accessors
			}

			let method = descriptor.value;

			if (typeof method === "function" && !(prop in Color)) {
				// We have a function, and no static version already
				Color[prop] = function(color, ...args) {
					color = Color.get(color);
					return color[prop](...args);
				};
			}
		}
	}
};

Object.assign(Color, {
	util,
	hooks: new Hooks(),
	whites: {
		D50: [0.96422, 1.00000, 0.82521],
		D65: [0.95047, 1.00000, 1.08883],
	},
	spaces: {},

	// These will be available as getters and setters on EVERY color instance.
	// They refer to LCH by default, but can be set to anything
	// and you can add more by calling Color.defineShortcut()
	shortcuts: {
		"lightness": "lch.lightness",
		"chroma": "lch.chroma",
		"hue": "lch.hue",
	},

	// Global defaults one may want to configure
	defaults: {
		gamutMapping: "lch.chroma",
		precision: 5
	}
});

Color.defineSpace({
	id: "xyz",
	name: "XYZ",
	coords: {
		X: [],
		Y: [],
		Z: []
	},
	inGamut: coords => true,
	toXYZ: coords => coords,
	fromXYZ: coords => coords
});

for (let prop in Color.shortcuts) {
	Color.defineShortcut(prop);
}

// Make static methods for all instance methods
Color.statify();

export {util};
