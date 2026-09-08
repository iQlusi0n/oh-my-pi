# ompx — fork launcher

`ompx` is this fork's command name. The launcher is [`scripts/ompx`](../scripts/ompx),
symlinked onto `PATH`; nothing inside the tree is renamed. The code still calls
itself `omp`, so `ompx --version` prints `omp/<version>` and the config
directory stays `.omp`.

That separation is deliberate. Renaming `APP_NAME`, the `bin` key, the `.omp`
config directory, or the `OMP_*`/`PI_*` environment prefixes would conflict on
every merge from upstream and would orphan existing state — including the
project-local session stores described in [session.md](session.md#on-disk-layout),
whose in-repo marker is the literal `.omp` directory name.

## What it does

- Runs `packages/coding-agent/dist/omp` from the checkout when a binary is built,
  otherwise runs `packages/coding-agent/src/cli.ts` directly.
- Shares `~/.omp` with an upstream-installed `omp`: same credentials, model
  database, global sessions, and blob store. No separate login.
- Exports `OMP_APP_NAME=ompx`, so broker-side per-client usage attribution
  separates this fork from an upstream install without splitting any state.

| Variable | Effect |
| --- | --- |
| `OMPX_REPO` | Checkout to run (default: the checkout the launcher lives in) |
| `OMPX_FROM_SOURCE=1` | Ignore the built binary and run the TypeScript entrypoint |

Use `OMPX_FROM_SOURCE=1` right after editing source, before rebuilding — a stale
binary is the usual reason a change "didn't take".

## Installing the launcher

```sh
ln -sfn "$PWD/scripts/ompx" ~/.local/bin/ompx
```

The script resolves its own symlink chain to find the checkout it lives in, so
the same command works from any clone and survives the repo being moved.
`OMPX_REPO` overrides the checkout it runs.

## Prerequisites

```sh
bun --version   # a real Bun on PATH
bun setup       # workspace dependencies + the local native addon
```

`bun setup` installs the Bun workspaces and builds `@oh-my-pi/pi-natives`, which
produces `packages/natives/native/pi_natives.<platform>.node`. Both the source
path and the binary build fail in the native loader without it.

Building that addon needs the Rust toolchain pinned by `rust-toolchain.toml`
(plus `clang`, `libclang-dev`, `cmake`, and `ninja` — see the root `Dockerfile`'s
`natives-builder` stage for the exact package list). Two options when a host has
no Rust toolchain:

- Copy a matching prebuilt addon out of an installed omp's cache:
  `cp ~/.omp/natives/<version>/pi_natives.<platform>-*.node packages/natives/native/`.
  The loader enforces an exact version match against `packages/natives/package.json`,
  so a cache directory from a different release will be rejected.
- Build in Docker instead (below), which compiles the addon from source in the
  image and never touches the host toolchain.

Note that a copied prebuilt is not built from this tree: local changes under
`crates/` are absent from it.

A real Bun matters for more than convenience — see the runtime-template warning
under [Rebuilding the binary](#rebuilding-the-binary).

## Rebuilding the binary

```sh
cd packages/coding-agent
bun run build          # -> packages/coding-agent/dist/omp
```

`scripts/build-binary.ts` generates the stats client, tool views, and the
embedded native addon, compiles with `Bun.build({ compile })`, then restores the
checked-in generated placeholders. Verify with:

```sh
./dist/omp --version      # must print `omp/<version>`
./dist/omp --smoke-test   # spawns the stats-sync worker and tiny-model subprocess
```

`--version` printing a bare Bun semver (e.g. `1.4.2`) instead of `omp/<version>`
means the compile used an already-compiled executable as its runtime template:
`Bun.build` templates from the running process, so building while `bun` is itself
a compiled application (for example a shim that runs the installed `omp` binary
with `BUN_BE_BUN=1`) produces a binary that boots as Bun with the app payload
inert. Build with a real Bun, or pass a clean runtime explicitly:

```sh
BUN_COMPILE_EXECUTABLE_PATH=/path/to/vanilla/bun bun run build
```

`CROSS_TARGET=linux-x64|linux-arm64|darwin-arm64|darwin-x64|win32-x64|win32-arm64`
builds for another platform and names the output `dist/omp-<target>`; Bun
downloads that target's runtime instead of templating from the host.

## Building in Docker

`Dockerfile.binary` produces the same artifact hermetically and compiles the Rust
addon from source rather than reusing a host cache:

```sh
docker build -f Dockerfile.binary --output type=local,dest=out .   # -> ./out/omp
```

It asserts `--version` starts with `omp/` and runs `--smoke-test` inside the
image, so a mis-templated or worker-broken binary fails the build instead of
shipping. `--target binary-builder -t omp-binary:dev` keeps the result in an
image instead of writing to the host.

The root `Dockerfile` is a different tool: it builds the native addon and then
ships an `omp` shim that runs the TypeScript entrypoint through Bun. Use it for a
runnable container, `Dockerfile.binary` when you want the executable.

## Startup cost

Compiled builds keep the CLI's lazy `import()` boundaries as separate chunks
(`splitting` in `scripts/compile-binary.ts`). Without that, every command module
plus the model catalog and docs index evaluate before any command answers —
measured 443 ms versus 48 ms on linux-x64. If startup regresses by roughly an
order of magnitude after a build-script change, check that setting first.
