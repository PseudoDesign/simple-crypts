#!/usr/bin/env python3
"""Build action implementation. All output is confined to Bazel's output tree."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def run(argv, **kwargs):
    if 'env' not in kwargs:
        kwargs['env'] = dict(os.environ, PATH='/usr/bin:/bin')
    subprocess.run(argv, check=True, **kwargs)


C_FLAGS = ["-std=c99", "-O2", "-g", "-fPIC", "-Wall", "-Wextra",
           "-D_POSIX_C_SOURCE=200809L"]


def cc(config):
    output = Path(config['output']).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='cc-') as tmp:
        objects = []
        for index, source in enumerate(config['srcs']):
            obj = str(Path(tmp) / (str(index) + '.o'))
            run(['/usr/bin/cc', *C_FLAGS, *config['copts'],
                 *['-I' + inc for inc in config['includes']], '-c', source, '-o', obj])
            objects.append(obj)
        if config['mode'] == 'archive':
            run(['/usr/bin/ar', 'rcs', str(output), *objects])
        else:
            run(['/usr/bin/cc', *(['-shared'] if config['mode'] == 'shared' else []),
                 '-o', str(output), *objects, '-Wl,--start-group',
                 *(['-Wl,--whole-archive'] if config['mode'] == 'shared' else []), *config['libraries'],
                 *(['-Wl,--no-whole-archive'] if config['mode'] == 'shared' else []), '-Wl,--end-group', *config['linkopts']])


def sodium(config):
    output = Path(config['output']).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='sodium-') as tmp:
        source = Path(tmp) / 'source'
        shutil.copytree(config['source'], source, symlinks=False)
        env = dict(os.environ)
        flags = '-Os -ffunction-sections -fdata-sections -fstack-usage'
        # Sodium defaults to PIE, which overrides -fPIC and makes its static
        # TLS objects unsuitable for linking into the CFFI/cgo shared library.
        argv = [str(source / 'configure'), '--disable-shared', '--enable-static',
                '--disable-pie', '--disable-asm', '--enable-minimal']
        if config['arm']:
            env.update(CC='/usr/bin/arm-none-eabi-gcc', AR='/usr/bin/arm-none-eabi-ar', RANLIB='/usr/bin/arm-none-eabi-ranlib')
            flags += ' -mcpu=cortex-m4 -mthumb'
            env['LDFLAGS'] = '--specs=nosys.specs'
            argv += ['--host=arm-none-eabi']
        else:
            flags += ' -fPIC'
        env['CFLAGS'] = flags
        env['PATH'] = '/usr/bin:/bin'
        log = Path(tmp) / 'build.log'
        try:
            with log.open('w') as stream:
                run(argv, cwd=source, env=env, stdout=stream, stderr=subprocess.STDOUT)
                run(['make', '-j2', '-C', 'src/libsodium'], cwd=source, env=env, stdout=stream, stderr=subprocess.STDOUT)
        except subprocess.CalledProcessError:
            print(log.read_text()[-15000:], file=sys.stderr)
            raise
        shutil.copyfile(source / 'src/libsodium/.libs/libsodium.a', output)
        Path(config['stack']).write_text(''.join(p.read_text() for p in sorted(source.rglob('*.su'))))


def sdk_binary(config):
    output = Path(config['output']).resolve()
    sdk = Path(config['sdk']).resolve()
    shared = Path(config['shared']).resolve() if config['shared'] else None
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='sdk-') as tmp:
        root = Path(tmp)
        for name in config['sources']:
            dest = root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(name, dest)
        env = dict(os.environ, PATH=str(sdk / 'bin') + ':/usr/bin:/bin')
        if shared:
            env['LD_LIBRARY_PATH'] = str(shared.parent)
        if config['kind'] == 'go':
            env.update(GOROOT=str(sdk), GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off',
                       GOCACHE=str(root / '.gocache'), GOPATH=str(root / '.gopath'), CGO_ENABLED='1',
                       CGO_LDFLAGS=('-L' + str(shared.parent)) if shared else '')
            module_mode = '-mod=vendor' if (root / config['module'] / 'vendor').is_dir() else '-mod=readonly'
            command = ['test', '-c'] if config.get('test_build') else ['build']
            run([str(sdk / 'bin/go'), *command, module_mode, '-trimpath', '-o', str(output), '.'],
                cwd=root / config['module'], env=env)
        else:
            env.update(CARGO_HOME=str(root / '.cargo-home'), RUSTFLAGS=('-L native=' + str(shared.parent)) if shared else '')
            cargo_config = root / '.cargo/config.toml'
            cargo_config.parent.mkdir()
            cargo_config.write_text('[source.crates-io]\nreplace-with="vendored-sources"\n[source.vendored-sources]\ndirectory="' + str(root / 'third_party/rust_crates') + '"\n')
            common = ['--offline', '--locked', '--release', '--manifest-path',
                      config['module'] + '/Cargo.toml', '--target-dir', str(root / '.target')]
            if config.get('test_build'):
                result = subprocess.run([str(sdk / 'bin/cargo'), 'test', *common, '--lib',
                                         '--no-run', '--message-format=json'], cwd=root,
                                        env=env, text=True, stdout=subprocess.PIPE, check=True)
                artifacts = [json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
                binaries = [a['executable'] for a in artifacts if a.get('reason') == 'compiler-artifact'
                            and a.get('profile', {}).get('test') and a.get('executable')]
                if len(binaries) != 1:
                    raise RuntimeError('expected exactly one Rust library test executable')
                shutil.copyfile(binaries[0], output)
            else:
                run([str(sdk / 'bin/cargo'), 'build', *common, '--bin', config['binary']], cwd=root, env=env)
                shutil.copyfile(root / '.target/release' / config['binary'], output)
            output.chmod(0o755)


def resource_report(config):
    outputs = {name: Path(path).resolve() for name, path in config['outputs'].items()}
    root = Path.cwd()
    for path in outputs.values():
        path.parent.mkdir(parents=True, exist_ok=True)
    compiler = '/usr/bin/arm-none-eabi-gcc'
    flags = ['-std=c99', '-Os', '-mcpu=cortex-m4', '-mthumb', '-ffunction-sections', '-fdata-sections', '-fstack-usage', '-g', '-Wall', '-Wextra']
    includes = ['-I.', '-Ithird_party/nanopb', '-Ithird_party/libsodium/src/libsodium/include']
    with tempfile.TemporaryDirectory(dir=outputs['probe.elf'].parent, prefix='cortex-') as tmp:
        temporary = Path(tmp)
        objects = []
        for index, source in enumerate(config['sources']):
            obj = temporary / (str(index) + '.o')
            run([compiler, *flags, *includes, '-c', source, '-o', str(obj)])
            objects.append(str(obj))
        run([compiler, '-mcpu=cortex-m4', '-mthumb', '-nostartfiles', '--specs=nosys.specs',
             '-Wl,--gc-sections', '-Wl,-Map=' + str(outputs['probe.map']), '-T', config['linker'],
             '-o', str(outputs['probe.elf']), *objects, config['archive'], '-lc', '-lgcc'])
        symbols = subprocess.check_output(['/usr/bin/arm-none-eabi-nm', '-S', str(outputs['probe.elf'])], text=True)
        required = ['crypto_box_easy', 'crypto_box_open_easy', 'sc_sodium_seal', 'sc_sodium_open', 'sc_receive', 'sc_outbound']
        for symbol in required:
            if not any(line.split()[-1] == symbol for line in symbols.splitlines() if line.split()):
                raise RuntimeError('Resource ELF did not retain required symbol: ' + symbol)
        size_text = subprocess.check_output(['/usr/bin/arm-none-eabi-size', str(outputs['probe.elf'])], text=True)
        outputs['size.txt'].write_text(size_text)
        sizes = [int(value) for value in size_text.splitlines()[1].split()[:3]]
        stack_text = Path(config['sodium_stack']).read_text() + ''.join(path.read_text() for path in sorted(temporary.glob('*.su')))
        # Build paths vary; source basenames and function/location remain useful.
        import re
        stack_text = re.sub(r'[^\s:]*?/source/', 'libsodium/', stack_text)
        outputs['stack_usage.txt'].write_text(stack_text)
        linked = {line.split()[-1] for line in symbols.splitlines() if line.split()}
        stack_rows = []
        for line in stack_text.splitlines():
            fields = line.split('\t')
            if len(fields) == 3:
                function = fields[0].rsplit(':', 1)[-1]
                if function in linked:
                    stack_rows.append({'function': function, 'bytes': int(fields[1]), 'classification': fields[2]})
        stack_rows.sort(key=lambda row: row['bytes'], reverse=True)
        data_symbols = []
        for line in symbols.splitlines():
            fields = line.split()
            if len(fields) == 4 and fields[2] in ('b', 'B', 'd', 'D'):
                data_symbols.append({'symbol': fields[3], 'bytes': int(fields[1], 16)})
        data_symbols.sort(key=lambda row: row['bytes'], reverse=True)
        compiler_version = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
        result = {'profile': 'Cortex-M4 / Thumb / -Os / no assembly / link-only', 'compiler': compiler_version,
                  'text_bytes': sizes[0], 'data_bytes': sizes[1], 'bss_bytes': sizes[2],
                  'flash_sections_bytes': sizes[0] + sizes[1], 'static_ram_bytes': sizes[1] + sizes[2],
                  'peak_stack_bytes': None, 'required_symbols_retained': required,
                  'largest_linked_function_stack_frames': stack_rows[:20], 'data_symbols': data_symbols,
                  'limitations': ['Not executed on hardware; no latency or energy claim.', 'Stack frame sizes are not a call-chain, interrupt, or whole-program peak.', 'Includes measurement harness state and buffers; not a board firmware budget.', 'Platform callbacks are nonproduction measurement stubs; linker address space is not a board capacity.', 'Generic software crypto defaults; no sodium_init/RNG/platform startup linked. Real board initialization must be validated.']}
        outputs['resource_report.json'].write_text(json.dumps(result, indent=2) + '\n')
        lines = ['# Cortex-M4 resource measurement', '', compiler_version, '',
                 '| Measurement | Bytes |', '|---|---:|',
                 '| Linked text / rodata | %d |' % sizes[0], '| Initialized data | %d |' % sizes[1],
                 '| Zero-initialized data | %d |' % sizes[2], '| Text + data (flash sections) | %d |' % (sizes[0]+sizes[1]),
                 '| Data + bss (static RAM) | %d |' % (sizes[1]+sizes[2]), '',
                 'Core, nanopb, the portable libsodium provider, and both authenticated encryption/decryption paths are retained in this ELF. The profile uses the same pinned libsodium 1.0.20 source and portable provider as the host.', '',
                 'The `endpoint`, frame, persistence-buffer, and fake-keystore symbols below belong to the measurement harness. Core context size is the `endpoint` symbol size. No total RAM or usable MCU minimum is claimed.', '',
                 '| Static symbol | Bytes |', '|---|---:|']
        lines.extend('| `%s` | %d |' % (row['symbol'], row['bytes']) for row in data_symbols)
        lines.extend(['', '## Largest retained per-function stack frames', '',
                      'Compiler `.su` records show individual function frames, not a maximum call-chain sum. Precompiled libc/libgcc, interrupts, board drivers, RTOS tasks and stacks, flash journal, startup, and entropy/provider integration need separate measurement.', '',
                      '| Function | Frame bytes | Classification |', '|---|---:|---|'])
        lines.extend('| `%s` | %d | %s |' % (row['function'], row['bytes'], row['classification']) for row in stack_rows[:20])
        lines.extend(['', '## Limits', ''] + ['- ' + item for item in result['limitations']])
        outputs['resource_report.md'].write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    globals()[sys.argv[1]](json.loads(sys.argv[2]))
