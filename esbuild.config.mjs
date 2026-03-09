import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";

const production = process.argv[2] === "production";

const copyPlugin = {
	name: 'copy-plugin',
	setup(build) {
		build.onEnd(() => {
			if (!fs.existsSync("dist")) {
				fs.mkdirSync("dist");
			}
			fs.copyFileSync("manifest.json", "dist/manifest.json");
			if (fs.existsSync("styles.css")) {
				fs.copyFileSync("styles.css", "dist/styles.css");
			}
		});
	}
};

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	outfile: "dist/main.js",
	bundle: true,
	format: "cjs",
	platform: "browser",
	target: "es2022",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	logLevel: "info",
	banner: {
		js: "/* Bundled with esbuild */",
	},
	plugins: [copyPlugin],
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins
	],
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}