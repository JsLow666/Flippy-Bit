/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html,
 * animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    merge,
    scan,
    startWith,
    switchMap,
    take,
} from "rxjs";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Target = {
    WIDTH: 64,
    HEIGHT: 36,
} as const;

const Constants = {
    DIGIT_COUNT: 8,
    TICK_RATE_MS: 50, // Might need to change this!
    FALL_SPEED: 5, // targets move down per tick
    CHECK_LINE_Y: Viewport.CANVAS_HEIGHT - 90,

    MIN_SPAWN_DELAY_MS: 1000, // one to three seconds
    MAX_SPAWN_DELAY_MS: 3000,

    BASE_FALL_SPEED: 2,
    SPEEDUP_INTERVAL_MS: 10000, //every 10 seconds, fall speed increases by 1
    SPEEDUP_INCREMENT: 1,
    MAX_FALL_SPEED: 10,
} as const;

// keyboard code that controls each digit
const DIGIT_KEY_CODES: ReadonlyArray<ReadonlyArray<string>> = [
    ["Digit1", "KeyA", "KeyZ"],
    ["Digit2", "KeyS", "KeyX"],
    ["Digit3", "KeyD", "KeyC"],
    ["Digit4", "KeyF", "KeyV"],
    ["Digit5", "KeyG", "KeyB"],
    ["Digit6", "KeyH", "KeyN"],
    ["Digit7", "KeyJ", "KeyM"],
    ["Digit8", "KeyK", "Comma"],
] as const;

abstract class RNG {
    private static m = 0x80000000;
    private static a = 1103515245;
    private static c = 12345;

    public static hash = (seed: number): number =>
        (RNG.a * seed + RNG.c) % RNG.m;

    public static scale = (hash: number): number =>
        (2 * hash) / (RNG.m - 1) - 1; // in [-1, 1]
}

// Maps a RNG.scale output to an integer range [min, max]
const scaleToRange = (scaled: number, min: number, max: number): number =>
    min + Math.floor(((scaled + 1) / 2) * (max - min + 1));

type FallingTarget = Readonly<{
    id: number;
    value: number;
    x: number;
    y: number;
}>;

// State processing
type State = Readonly<{
    gameEnd: boolean;
    bits: ReadonlyArray<number>; //immutable
    targets: ReadonlyArray<FallingTarget>;
    nextId: number;
    score: number;
    elapsedMs: number; // survival time, used to speed the game up over time
    paused: boolean;
}>;

const initialState: State = {
    gameEnd: false,
    bits: [0, 0, 0, 0, 0, 0, 0, 0],
    targets: [],
    nextId: 0,
    score: 0,
    elapsedMs: 0,
    paused: false,
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

// Convert binary array to hexadecimal string
const bitsToHex = (bits: ReadonlyArray<number>): string => {
    const binary = bits.join("");
    const decimal = parseInt(binary, 2);

    return decimal.toString(16).toUpperCase();
};

const render = (): ((s: State) => void) => {
    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;
    const scoreText = document.querySelector("#scoreText") as SVGTextElement;
    const valueText = document.querySelector("#valueText") as SVGTextElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );
    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */
    return (s: State) => {
        // clear everything drawn last frame
        Array.from(svg.children).forEach(child => svg.removeChild(child));

        // Draw the "check line"
        const checkLine = createSvgElement(svg.namespaceURI, "line", {
            x1: "0",
            y1: `${Constants.CHECK_LINE_Y}`, //starting
            x2: `${Viewport.CANVAS_WIDTH}`,
            y2: `${Constants.CHECK_LINE_Y}`, // ending
            stroke: "black",
        });
        svg.appendChild(checkLine);

        // Draw targets
        s.targets.forEach((t, i) => {
            const targetRect = createSvgElement(svg.namespaceURI, "rect", {
                x: `${t.x}`,
                y: `${t.y}`,
                width: `${Target.WIDTH}`,
                height: `${Target.HEIGHT}`,
                rx: "6",
                fill: "white",
                stroke: "black",
                "stroke-width": "2",
            });
            const targetText = createSvgElement(svg.namespaceURI, "text", {
                x: `${t.x + Target.WIDTH / 2}`,
                y: `${t.y + Target.HEIGHT / 2 + 8}`,
                "text-anchor": "middle",
                "font-family": "monospace",
                fill: "black",
            });
            targetText.textContent = t.value.toString(16).toUpperCase();
            svg.appendChild(targetRect);
            svg.appendChild(targetText);
        });

        // Draw digits
        const digitWidth = Viewport.CANVAS_WIDTH / Constants.DIGIT_COUNT;
        Array.from({ length: Constants.DIGIT_COUNT }).forEach((_, i) => {
            const bit = createSvgElement(svg.namespaceURI, "rect", {
                x: `${i * digitWidth + 4}`,
                y: `${Viewport.CANVAS_HEIGHT - 50}`,
                width: `${digitWidth - 8}`,
                height: "40",
                // green when 1, red when 0
                fill: s.bits[i] === 1 ? "#81c784" : "#ef9a9a",
                stroke: "black",
                "stroke-width": "2",
                cursor: "pointer",
                bitIndex: `${i}`,
            });
            const bitText = createSvgElement(svg.namespaceURI, "text", {
                x: `${i * digitWidth + digitWidth / 2}`,
                y: `${Viewport.CANVAS_HEIGHT - 22}`,
                "text-anchor": "middle",
                "font-family": "monospace",
                fill: "black",
            });
            //update the bits content based on the current state
            bitText.textContent = `${s.bits[i]}`;
            svg.appendChild(bit);
            svg.appendChild(bitText);
        });

        // show "PAUSED" message
        if (s.paused && !s.gameEnd) {
            const pausedText = createSvgElement(svg.namespaceURI, "text", {
                x: `${Viewport.CANVAS_WIDTH / 2}`,
                y: `${Viewport.CANVAS_HEIGHT / 2}`,
                "text-anchor": "middle",
                "font-family": "monospace",
                "font-size": "32",
                fill: "blue",
            });
            pausedText.textContent = "PAUSED - press P to resume";
            svg.appendChild(pausedText);
        }

        // Show a "GAME OVER"
        if (s.gameEnd) {
            const gameOverText = createSvgElement(svg.namespaceURI, "text", {
                x: `${Viewport.CANVAS_WIDTH / 2}`,
                y: `${Viewport.CANVAS_HEIGHT / 2}`,
                "text-anchor": "middle",
                "font-family": "monospace",
                "font-size": "32",
                fill: "red",
            });
            gameOverText.textContent = "GAME OVER - press R to restart";
            svg.appendChild(gameOverText);
        }

        scoreText.textContent = `${s.score}`;
        valueText.textContent = `${bitsToHex(s.bits)}`;
    };
};

// flips bit index in bit array
const toggleBit = (
    bits: ReadonlyArray<number>,
    index: number,
): ReadonlyArray<number> => bits.map((bit, i) => (i === index ? 1 - bit : bit));

// event for keydown
const key$ = fromEvent<KeyboardEvent>(document, "keydown");

// function to create an observable for each digit key press
// avoid hardcoding each digit key press observable
const fromDigit = (digit: number) =>
    key$.pipe(
        filter(({ code }) => DIGIT_KEY_CODES[digit - 1].includes(code)),
        map(() => (state: State): State => {
            if (state.gameEnd || state.paused) return state;

            return {
                ...state,
                bits: toggleBit(state.bits, digit - 1),
            };
        }),
    );

const keyboardClick$ = merge(
    fromDigit(1),
    fromDigit(2),
    fromDigit(3),
    fromDigit(4),
    fromDigit(5),
    fromDigit(6),
    fromDigit(7),
    fromDigit(8),
);

// click to change the bit value
const mouseClick$: Observable<(s: State) => State> = fromEvent<MouseEvent>(
    document,
    "mousedown",
).pipe(
    // get the bit index from the clicked element
    map(event => (event.target as Element).getAttribute("bitIndex")),
    filter(index => index !== null),
    map(index => Number(index)),
    map(index => (state: State): State => {
        // ignore clicks once the game has ended or paused
        if (state.gameEnd || state.paused) return state;

        return { ...state, bits: toggleBit(state.bits, index) };
    }),
);

// decide when the next target spawns
type SpawnClock = Readonly<{
    seed: number;
    remainingMs: number;
    spawnedTarget: Readonly<{ value: number; x: number }> | null;
}>;

// impure to make the first spawn time and value random
const firstDelaySeed = RNG.hash(Math.random());
const initialSpawnClock: SpawnClock = {
    seed: firstDelaySeed,
    remainingMs: scaleToRange(
        RNG.scale(firstDelaySeed),
        Constants.MIN_SPAWN_DELAY_MS,
        Constants.MAX_SPAWN_DELAY_MS,
    ),
    spawnedTarget: null,
};

const spawnClock$: Observable<SpawnClock> = interval(
    Constants.TICK_RATE_MS,
).pipe(
    scan((clock: SpawnClock): SpawnClock => {
        // Still counting down - no spawn this tick.
        if (clock.remainingMs > Constants.TICK_RATE_MS) {
            return {
                ...clock,
                remainingMs: clock.remainingMs - Constants.TICK_RATE_MS,
                spawnedTarget: null,
            };
        }

        // random delay, value, x position for the next target spawn
        const delaySeed = RNG.hash(Math.random());
        const nextDelay = scaleToRange(
            RNG.scale(delaySeed),
            Constants.MIN_SPAWN_DELAY_MS,
            Constants.MAX_SPAWN_DELAY_MS,
        );

        const valueSeed = RNG.hash(delaySeed);
        const value = scaleToRange(RNG.scale(valueSeed), 0, 255); // 8-bit digit

        const xSeed = RNG.hash(valueSeed);
        const x = scaleToRange(
            RNG.scale(xSeed),
            0,
            Viewport.CANVAS_WIDTH - Target.WIDTH,
        ); // x position of the target

        return {
            seed: xSeed,
            remainingMs: nextDelay,
            spawnedTarget: { value, x },
        };
    }, initialSpawnClock),
);

const spawn$: Observable<(s: State) => State> = spawnClock$.pipe(
    filter(clock => clock.spawnedTarget !== null),
    map(clock => (s: State): State => {
        // stop spawning once the game is over or paused
        if (s.gameEnd || s.paused) return s;

        const { value, x } = clock.spawnedTarget!;

        // create a new target
        const newTarget: FallingTarget = {
            id: s.nextId,
            value,
            x,
            y: 40,
        };

        return {
            ...s,
            // append to the back of the queue
            targets: [...s.targets, newTarget],
            nextId: s.nextId + 1,
        };
    }),
);

// The target fall speed increase every 10 seconds, with maximum speed of 10
const currentFallSpeed = (elapsedMs: number): number =>
    Math.min(
        Constants.BASE_FALL_SPEED +
            Math.floor(elapsedMs / Constants.SPEEDUP_INTERVAL_MS) *
                Constants.SPEEDUP_INCREMENT,
        Constants.MAX_FALL_SPEED,
    );

// moves every target down
const tick$: Observable<(s: State) => State> = interval(
    Constants.TICK_RATE_MS,
).pipe(
    map(() => (s: State): State => {
        // freeze once the game ends or paused
        if (s.gameEnd || s.paused) return s;

        const fallSpeed = currentFallSpeed(s.elapsedMs);

        return {
            ...s,
            elapsedMs: s.elapsedMs + Constants.TICK_RATE_MS,
            targets: s.targets.map(t => ({
                ...t,
                y: t.y + fallSpeed,
            })),
        };
    }),
);

// check target match
const checkMatch = (s: State): State => {
    if (s.gameEnd || s.paused) return s;

    const front = s.targets[0];
    if (front === undefined) return s; // nothing to check

    const playerValue = parseInt(s.bits.join(""), 2);
    if (playerValue !== front.value) return s; // no match, do nothing

    // match, so remove the target and reset bits
    return {
        ...s,
        targets: s.targets.slice(1),
        bits: s.bits.map(() => 0), //reset
        score: s.score + 1,
    };
};

// Checks whether target reach the check line
const checkFailure = (s: State): State => {
    if (s.gameEnd || s.paused) return s;

    const front = s.targets[0];
    if (front === undefined) return s;

    return front.y >= Constants.CHECK_LINE_Y - Target.HEIGHT
        ? { ...s, gameEnd: true }
        : s;
};

// press R to restart the game
const restart$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
    filter(({ code }) => code === "KeyR"),
    startWith(null),
);

// press P to pause the game
const pause$: Observable<(s: State) => State> = key$.pipe(
    filter(({ code }) => code === "KeyP"),
    map(
        () =>
            (state: State): State =>
                state.gameEnd ? state : { ...state, paused: !state.paused },
    ),
);

export const state$ = (): Observable<State> =>
    restart$.pipe(
        switchMap(() =>
            merge(spawn$, tick$, keyboardClick$, mouseClick$, pause$).pipe(
                scan(
                    (state, reducerFn) =>
                        checkFailure(checkMatch(reducerFn(state))),
                    initialState,
                ),
            ),
        ),
    );

// The following simply runs your main function on window load.
// Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    click$.pipe(switchMap(() => state$())).subscribe(render());
}
