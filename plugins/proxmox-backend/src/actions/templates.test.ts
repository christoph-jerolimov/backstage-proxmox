import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { parse } from 'yaml';
import { PROXMOX_ACTION_NAMES } from './index';
import { setupActions } from '../__testUtils__/actionHarness';

const TEMPLATE_DIR = resolve(
  __dirname,
  '../../../../examples/proxmox-templates',
);

type Template = {
  metadata: { name: string; title: string; description: string };
  spec: {
    owner: string;
    type: string;
    parameters: Array<{
      required?: string[];
      properties?: Record<string, unknown>;
    }>;
    steps: Array<{
      id: string;
      action: string;
      input: Record<string, unknown> & { waitForCompletion?: boolean };
    }>;
    output?: unknown;
  };
};

const SHOWCASE_DIR = resolve(TEMPLATE_DIR, 'showcase');

function load(dir: string): Array<[string, Template]> {
  return readdirSync(dir)
    .filter(file => file.endsWith('.yaml'))
    .map(file => [file, parse(readFileSync(resolve(dir, file), 'utf8'))]);
}

// Per-action templates live at the top level; multi-step showcase templates
// live in their own directory, so the one-template-per-action invariant below
// stays meaningful.
const templates = load(TEMPLATE_DIR);
const showcases = load(SHOWCASE_DIR);

describe('Proxmox software templates', () => {
  it('ships exactly one template per action', () => {
    const actions = templates.map(
      ([, template]) => template.spec.steps[0].action,
    );

    expect(actions.sort()).toEqual(
      PROXMOX_ACTION_NAMES.map(name => `proxmox:${name}`).sort(),
    );
    expect(new Set(actions).size).toBe(templates.length);
  });

  it('ships at least one showcase template, kept apart from the per-action ones', () => {
    expect(showcases.length).toBeGreaterThan(0);
    expect(templates.map(([file]) => file)).not.toContain('showcase');
  });

  it('runs exactly one step per per-action template', () => {
    for (const [file, template] of templates) {
      expect([file, template.spec.steps.length]).toEqual([file, 1]);
    }
  });

  it('names the action it invokes in its description', () => {
    for (const [file, template] of templates) {
      expect([file, template.metadata.description]).toEqual([
        file,
        expect.stringContaining(template.spec.steps[0].action),
      ]);
    }
  });

  it('declares a consistent owner and type', () => {
    for (const [file, template] of templates) {
      expect([file, template.spec.owner, template.spec.type]).toEqual([
        file,
        'user:guest',
        'proxmox-action',
      ]);
    }
  });

  it('marks as required exactly the inputs the action requires', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const required = Object.fromEntries(
      actions.map(action => [
        `proxmox:${action.name}`,
        (
          (action.schema.input as { required?: string[] }).required ?? []
        ).sort(),
      ]),
    );

    for (const [file, template] of templates) {
      const action = template.spec.steps[0].action;
      const templateRequired = template.spec.parameters
        .flatMap(section => section.required ?? [])
        .sort();

      expect([file, templateRequired]).toEqual([file, required[action]]);
    }
  });

  it('passes every parameter it collects through to the action', () => {
    for (const [file, template] of templates) {
      const parameters = template.spec.parameters.flatMap(section =>
        Object.keys(section.properties ?? {}),
      );
      const input = template.spec.steps[0].input;

      for (const parameter of parameters) {
        expect([file, parameter, input[parameter]]).toEqual([
          file,
          parameter,
          `\${{ parameters.${parameter} }}`,
        ]);
      }
    }
  });

  it('only passes inputs the action accepts', async () => {
    const { registry } = setupActions();
    const { actions } = await registry.list();
    const accepted = Object.fromEntries(
      actions.map(action => [
        `proxmox:${action.name}`,
        Object.keys(
          (action.schema.input as { properties?: object }).properties ?? {},
        ),
      ]),
    );

    for (const [file, template] of templates) {
      const action = template.spec.steps[0].action;
      for (const key of Object.keys(template.spec.steps[0].input)) {
        expect([file, key]).toEqual([
          file,
          expect.stringMatching(
            new RegExp(`^(${accepted[action].join('|')})$`),
          ),
        ]);
      }
    }
  });

  it('reports the connection and the identifying values it acted on', () => {
    for (const [file, template] of templates) {
      const rendered = JSON.stringify(template.spec.output);
      expect([file, rendered]).toEqual([
        file,
        expect.stringContaining('connectionTitle'),
      ]);
    }
  });

  describe('showcase templates', () => {
    it('only reference registered actions', async () => {
      const { registry } = setupActions();
      const { actions } = await registry.list();
      const registered = actions.map(action => `proxmox:${action.name}`);

      for (const [file, template] of showcases) {
        for (const step of template.spec.steps) {
          expect([file, step.action]).toEqual([
            file,
            expect.stringMatching(new RegExp(`^(${registered.join('|')})$`)),
          ]);
        }
      }
    });

    it('chain more than one step, which is what makes them showcases', () => {
      for (const [file, template] of showcases) {
        expect([file, template.spec.steps.length > 1]).toEqual([file, true]);
      }
    });

    it('are typed apart from the per-action templates', () => {
      for (const [file, template] of showcases) {
        expect([file, template.spec.type]).toEqual([file, 'proxmox-showcase']);
      }
    });

    it('pass every parameter they collect through to a step', () => {
      for (const [file, template] of showcases) {
        const parameters = template.spec.parameters.flatMap(section =>
          Object.keys(section.properties ?? {}),
        );
        const used = JSON.stringify(template.spec.steps);

        for (const parameter of parameters) {
          expect([
            file,
            parameter,
            used.includes(`parameters.${parameter}`),
          ]).toEqual([file, parameter, true]);
        }
      }
    });

    it('feed the task ids of their non-waiting steps into a waiting step', () => {
      for (const [file, template] of showcases) {
        const waiting = template.spec.steps.filter(
          step => step.action === 'proxmox:wait-for-tasks',
        );
        if (waiting.length === 0) {
          continue;
        }
        const notWaiting = template.spec.steps.filter(
          step => step.input?.waitForCompletion === false,
        );
        expect([file, notWaiting.length > 1]).toEqual([file, true]);

        const awaited = JSON.stringify(waiting.map(step => step.input));
        for (const step of notWaiting) {
          expect([
            file,
            step.id,
            awaited.includes(`steps['${step.id}'].output.taskId`),
          ]).toEqual([file, step.id, true]);
        }
      }
    });
  });
});
