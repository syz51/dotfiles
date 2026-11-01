#!/usr/bin/env python3
"""Opt-in installed-skill evaluations; reuse the maintained conservative trace engine."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument(
        '--engine-root', type=Path,
        default=Path.home() / '.local/share/codex-skills/repository',
    )
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument(
        '--bounded-reads', action='store_true',
        help='Controlled trace-attribution run; constrain read format without naming skills',
    )
    modes.add_argument(
        '--ordinary-verification', action='store_true',
        help='Ordinary syntax with per-run source-input evidence and attributed compound reads',
    )
    options, remaining = parser.parse_known_args(argv)
    if options.ordinary_verification and any(
            value == '--skills-root' or value.startswith('--skills-root=')
            for value in remaining):
        raise SystemExit('Ordinary verification requires installed user configuration; --skills-root is not allowed.')
    engine = options.engine_root.expanduser().resolve() / 'scripts'
    required = ('skill_evals.py', 'activation_trace.py', 'read_guidance.py')
    if not all((engine / name).is_file() for name in required):
        raise SystemExit('Missing maintained skill evaluation engine; install codex-skills or pass --engine-root.')
    home = Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex')
    instructions = home / 'AGENTS.md'
    tracked = {name: engine / name for name in required} | {'globalAgents': instructions}
    if options.ordinary_verification:
        tracked.update({name: Path(__file__).with_name(name)
                        for name in ('full_skill_run.py', 'ordinary_trace.py', 'source_evidence.py')})
    before = {
        name: hashlib.sha256(path.read_bytes()).hexdigest()
        for name, path in tracked.items()
    }
    metadata = {
        'hermeticSourceScope': options.bounded_reads,
        'controlledReadFormat': options.bounded_reads,
        'ordinaryVerification': options.ordinary_verification,
        'engineRoot': str(options.engine_root.resolve()),
        'engineSha256': {name: before[name] for name in required},
        'globalAgentsSha256': before['globalAgents'],
        'ordinaryHelperSha256': {name: before[name] for name in
                                 ('full_skill_run.py', 'ordinary_trace.py', 'source_evidence.py')
                                 if name in before},
    }
    sys.path.insert(0, str(engine))
    import skill_evals as ev
    if options.ordinary_verification:
        import full_skill_run
        ev.run_case = lambda *args, **kwargs: full_skill_run.run_case(ev, *args, **kwargs)
    ev.REFERENCES['typescript/effect'] = ('typescript', 'references/effect.md')
    cases = ev.load_cases()
    early_drift = [name for name, file in tracked.items()
                   if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != before[name]]
    if early_drift:
        raise SystemExit('Evaluation inputs changed during engine loading: ' + ', '.join(early_drift))
    extra_case = (Path(__file__).resolve().parents[1]
                  / 'tests/fixtures/effect-activation.json')
    cases.append(json.loads(extra_case.read_text()))
    if options.bounded_reads:
        for case in cases:
            case['prompt'] += (
                '\nFor attributable guidance reads, read each file separately with '
                'literal single-file cat or the shared guidance helper. Avoid shell '
                'loops, computed read paths, and mixed inventory/read commands. '
                'This controlled attribution run is scoped to the synthetic fixture '
                'and current installed guidance only; do not search memories, '
                'archives, or other projects.'
            )
    with tempfile.TemporaryDirectory(prefix='agents-dispatch-') as temp:
        path = Path(temp) / 'cases.json'
        path.write_text(json.dumps(cases))
        code = ev.main([*remaining, '--cases', str(path)])
        drift = [name for name, file in tracked.items()
                 if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != before[name]]
        if drift:
            code = 1
        metadata['drift'] = drift
        if 'run' in remaining and '--output-dir' in remaining:
            output = Path(remaining[remaining.index('--output-dir') + 1])
            if output.is_dir():
                (output / 'dispatch-engine.json').write_text(
                    json.dumps(metadata, indent=2) + '\n'
                )
        return code


if __name__ == '__main__':
    raise SystemExit(main())
