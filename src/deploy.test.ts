import { assertEquals } from 'jsr:@std/assert'

/**
 * The Dockerfile and `deno.json` both spell out the server's permissions, and
 * nothing connects them.
 *
 * They drifted once, and the failure was expensive to read: `--allow-ffi` was
 * added to the tasks so sharp could load, missed in the Dockerfile, and the
 * deployment died at boot with a long error recommending various `npm install`
 * incantations — none of which were the problem. The actual cause was one line
 * further down, and the binary had installed perfectly.
 */

const dockerfile = await Deno.readTextFile(new URL('../Dockerfile', import.meta.url))
const denoJson = JSON.parse(await Deno.readTextFile(new URL('../deno.json', import.meta.url))) as {
	tasks: Record<string, string>
}

/** Every `--allow-*` / `--deny-*` flag in a command, sorted. */
function permissions(command: string): string[] {
	return [...command.matchAll(/--(?:allow|deny)-[a-z-]+/g)].map((m) => m[0]).sort()
}

Deno.test('the Dockerfile CMD grants what the start task grants', () => {
	const cmd = /^CMD \[(.+)\]$/m.exec(dockerfile)?.[1]
	assertEquals(typeof cmd, 'string', 'no CMD array found in the Dockerfile')

	assertEquals(
		permissions(cmd!),
		permissions(denoJson.tasks.start ?? ''),
		'Dockerfile CMD and the `start` task grant different permissions',
	)
})

Deno.test('the Dockerfile runs the same entry point as the start task', () => {
	const cmd = /^CMD \[(.+)\]$/m.exec(dockerfile)?.[1] ?? ''
	assertEquals(cmd.includes('src/index.ts'), true)
	assertEquals(denoJson.tasks.start?.includes('src/index.ts'), true)
})

Deno.test('sharp still has the FFI access it needs', () => {
	// Not a style point: without it the server exits at boot the moment anything
	// touches the cover-colour path.
	assertEquals(permissions(denoJson.tasks.start ?? '').includes('--allow-ffi'), true)
	assertEquals(permissions(denoJson.tasks['colors:backfill'] ?? '').includes('--allow-ffi'), true)
})
