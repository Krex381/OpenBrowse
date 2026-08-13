import {
  Kind,
  parse as parseGraphql,
  type FieldNode,
  type ValueNode,
} from "graphql";
import type { Page } from "playwright";
import { OpenBrowseError } from "../errors.js";

export type BqlField = {
  name: string;
  key: string;
  args: Record<string, unknown>;
  selection: readonly FieldNode[];
};

function bqlValue(
  node: ValueNode,
  variables: Record<string, unknown>,
): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      if (!(node.name.value in variables))
        throw new OpenBrowseError(
          "INVALID_REQUEST",
          `Missing BrowserQL variable: ${node.name.value}`,
          400,
        );
      return variables[node.name.value];
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((value) => bqlValue(value, variables));
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((field) => [
          field.name.value,
          bqlValue(field.value, variables),
        ]),
      );
  }
}

export function parseBql(
  query: string,
  variables: Record<string, unknown>,
): BqlField[] {
  let document: ReturnType<typeof parseGraphql>;
  try {
    document = parseGraphql(query, { noLocation: true });
  } catch {
    throw new OpenBrowseError(
      "INVALID_REQUEST",
      "BrowserQL query is not valid GraphQL",
      400,
    );
  }
  const operation = document.definitions.find(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operation || operation.operation !== "mutation")
    throw new OpenBrowseError(
      "INVALID_REQUEST",
      "BrowserQL requires one mutation operation",
      400,
    );
  if (operation.selectionSet.selections.length > 25)
    throw new OpenBrowseError(
      "INVALID_REQUEST",
      "BrowserQL mutation has too many actions",
      400,
    );
  return operation.selectionSet.selections.map((selection) => {
    if (selection.kind !== Kind.FIELD)
      throw new OpenBrowseError(
        "INVALID_REQUEST",
        "BrowserQL fragments are not supported",
        400,
      );
    return {
      name: selection.name.value,
      key: selection.alias?.value ?? selection.name.value,
      args: Object.fromEntries(
        (selection.arguments ?? []).map((argument) => [
          argument.name.value,
          bqlValue(argument.value, variables),
        ]),
      ),
      selection:
        selection.selectionSet?.selections.map((child) => {
          if (child.kind !== Kind.FIELD)
            throw new OpenBrowseError(
              "INVALID_REQUEST",
              "BrowserQL fragments are not supported",
              400,
            );
          return child;
        }) ?? [],
    };
  });
}

export function selectBqlResponse(
  value: unknown,
  selection: readonly FieldNode[],
): unknown {
  if (!selection.length || value === null || typeof value !== "object")
    return value;
  if (Array.isArray(value))
    return value.map((item) => selectBqlResponse(item, selection));
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    selection.map((field) => [
      field.alias?.value ?? field.name.value,
      selectBqlResponse(
        source[field.name.value],
        field.selectionSet?.selections.filter(
          (child): child is FieldNode => child.kind === Kind.FIELD,
        ) ?? [],
      ),
    ]),
  );
}

export async function agentSnapshot(page: Page, maxElements: number) {
  return page
    .locator(
      "a,button,input,select,textarea,[role=button],[role=link],h1,h2,h3,h4,h5,h6,img[alt]",
    )
    .evaluateAll(
      (elements, limit) =>
        elements.slice(0, limit).map((element, index) => {
          const escaped = (value: string) =>
            value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const tag = element.tagName.toLowerCase();
          const id = element.getAttribute("id");
          const testId = element.getAttribute("data-testid");
          const name = element.getAttribute("name");
          const selector = testId
            ? `[data-testid="${escaped(testId)}"]`
            : id
              ? `[id="${escaped(id)}"]`
              : name
                ? `${tag}[name="${escaped(name)}"]`
                : tag;
          const text = (
            element.textContent ??
            element.getAttribute("aria-label") ??
            element.getAttribute("alt") ??
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 300);
          return {
            ref: `@e${index + 1}`,
            selector,
            tag,
            role: element.getAttribute("role") ?? undefined,
            type: element.getAttribute("type") ?? undefined,
            text,
            href: element.getAttribute("href") ?? undefined,
          };
        }),
      maxElements,
    );
}
