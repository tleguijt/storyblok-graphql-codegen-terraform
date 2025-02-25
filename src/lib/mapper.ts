import { camelCase, paramCase, sentenceCase, snakeCase } from 'change-case'
import {
  BooleanValueNode,
  ConstListValueNode,
  EnumValueNode,
  FieldDefinitionNode,
  GraphQLSchema,
  IntValueNode,
  ObjectTypeDefinitionNode,
  StringValueNode,
  TypeNode,
  isEnumType,
  isObjectType,
  isUnionType,
} from 'graphql'
import { Resource, arg, list, map } from 'terraform-generator'
import {
  findStoryblokFieldValue,
  findStoryblokValue,
  hasDirective,
  switchArray,
  typeName,
} from './graphql'
import {
  AssetComponentField,
  BloksComponentField,
  BooleanComponentField,
  Component,
  ComponentField,
  CustomComponentField,
  DatetimeComponentField,
  MarkdownComponentField,
  MultiassetComponentField,
  MultilinkComponentField,
  NumberComponentField,
  OptionComponentField,
  OptionsComponentField,
  RichtextComponentField,
  SectionComponentField,
  TabComponentField,
  TableComponentField,
  TextComponentField,
  TextareaComponentField,
} from './types'
import { ifValue, isValue, uniqueBy } from './value'

export type CtConfig = {
  projectKey: string
  endpoint: string
  clientId: string
  clientSecret: string
  locale: string
}

export const toComponent = (
  node: ObjectTypeDefinitionNode,
  spaceId: number,
  componentGroup: Resource | undefined,
  schema: GraphQLSchema,
  ctConfig?: CtConfig
): Component => ({
  name: snakeCase(node.name.value),
  space_id: spaceId,
  is_root: ['contentType', 'universal'].includes(
    findStoryblokValue<EnumValueNode>(node, 'type')?.value ?? ''
  ),
  is_nestable:
    findStoryblokValue<EnumValueNode>(node, 'type')?.value !== 'contentType' ??
    true,
  icon: ifValue(
    findStoryblokValue<EnumValueNode>(node, 'icon')?.value,
    toIconValue
  ),
  color: findStoryblokValue<StringValueNode>(node, 'color')?.value,
  image: findStoryblokValue<StringValueNode>(node, 'image')?.value,
  display_name: findStoryblokValue<StringValueNode>(node, 'displayName')?.value,
  component_group_uuid: componentGroup?.attr('uuid'),
  schema: map(toSchema(node, schema, ctConfig)),
  ...previewField(node),
})

const previewField = (node: ObjectTypeDefinitionNode) => {
  const value = findStoryblokValue<StringValueNode>(node, 'preview')?.value

  return !value
    ? {}
    : node.fields?.some((f) => f.name.value === value)
    ? { preview_field: snakeCase(value) }
    : { preview_tmpl: value }
}

const toIconValue = (value: string) =>
  value === 'block_at' ? 'block-@' : value.replace(/_/g, '-')

export const toSchema = (
  node: ObjectTypeDefinitionNode,
  schema: GraphQLSchema,
  ctConfig?: CtConfig
) =>
  Object.fromEntries([
    // Normal fields
    ...(node.fields
      ?.filter((field) => hasDirective(field, 'storyblokField'))
      .map((field, position) => [
        field.name.value,
        map({
          position,
          translatable: findStoryblokFieldValue<BooleanValueNode>(
            field,
            'translatable'
          )?.value,
          default_value: findStoryblokFieldValue<StringValueNode>(
            field,
            'default'
          )?.value,
          no_translate: findStoryblokFieldValue<StringValueNode>(
            field,
            'excludeFromExport'
          )?.value,
          display_name:
            findStoryblokFieldValue<StringValueNode>(field, 'displayName')
              ?.value ?? sentenceCase(field.name.value),
          required: field.type.kind === 'NonNullType',
          description: field.description?.value,
          ...switchArray<ComponentField>(field.type, {
            ifArray: (subType) =>
              toArrayComponentField(field, subType, schema, ctConfig),
            other: (type) => toComponentField(field, type, schema, ctConfig),
          }),
        }),
      ]) ?? []),
    // Sections
    ...(getUniqueDirectiveProps(node, 'section')?.map((name, position) => [
      camelCase(`section ${name}`),
      map({
        position: position + (node.fields?.length ?? 0),
        ...toFieldGroupComponentField(node, 'section', name),
      }),
    ]) ?? []),
    // Tabs
    ...(getUniqueDirectiveProps(node, 'tab')?.map((name, position) => [
      camelCase(`tab ${name}`),
      map({
        position:
          position +
          (getUniqueDirectiveProps(node, 'section')?.length ?? 0) +
          (node.fields?.length ?? 0),
        ...toFieldGroupComponentField(node, 'tab', name),
      }),
    ]) ?? []),
  ])

const getUniqueDirectiveProps = (
  node: ObjectTypeDefinitionNode,
  directiveProp: 'tab' | 'section'
) =>
  node.fields
    ?.map(
      (field) =>
        findStoryblokFieldValue<StringValueNode>(field, directiveProp)?.value
    )
    .filter(uniqueBy((x) => x))
    .filter(isValue)

const toFieldGroupComponentField = (
  node: ObjectTypeDefinitionNode,
  directiveProp: 'tab' | 'section',
  name: string
): SectionComponentField | TabComponentField => ({
  type: directiveProp,
  display_name: name,
  keys: [
    // get all tab or section field names
    ...(node.fields
      ?.filter(
        (field) =>
          findStoryblokFieldValue<StringValueNode>(field, directiveProp)
            ?.value === name
      )
      .map((field) => field.name.value) ?? []),
    // special case for sections in tabs: add section field names for this tab
    ...(directiveProp === 'tab'
      ? [
          ...(
            node.fields?.filter(
              (field) =>
                findStoryblokFieldValue<StringValueNode>(field, 'tab')
                  ?.value === name &&
                findStoryblokFieldValue<StringValueNode>(field, 'section')
            ) ?? []
          )
            .map(
              (field) =>
                findStoryblokFieldValue<StringValueNode>(field, 'section')
                  ?.value
            )
            .map((name) => camelCase(`section ${name}`))
            .filter(uniqueBy((x) => x)),
        ]
      : []),
  ],
})

const toArrayComponentField = (
  field: FieldDefinitionNode,
  type: TypeNode,
  schema: GraphQLSchema,
  ctConfig?: CtConfig
):
  | OptionsComponentField
  | MultiassetComponentField
  | BloksComponentField
  | CustomComponentField => {
  const node = schema.getType(typeName(type))

  if (node?.name === 'StoryblokAsset') {
    return {
      type: 'multiasset',
      filetypes:
        findStoryblokFieldValue<ConstListValueNode>(field, 'filetypes')
          ?.values.map((v) =>
            v.kind === 'EnumValue' ? (v.value as 'images') : undefined
          )
          .filter(isValue) ?? [],
    }
  }

  if (isObjectType(node) || isUnionType(node)) {
    const types = isUnionType(node)
      ? node.astNode?.types
          ?.map((t) => schema.getType(t.name.value))
          .filter(isObjectType)
          .map((t) => t.astNode!)
      : [node.astNode!]

    // all types must have a @storyblok(type: contentType) directive
    const isContentReference = types?.every((node) =>
      ['contentType', 'universal'].includes(
        findStoryblokValue<EnumValueNode>(node, 'type')?.value ?? ''
      )
    )

    if (isContentReference) {
      return {
        type: 'options',
        source: 'internal_stories',
        filter_content_type: types?.map((t) => snakeCase(t.name.value)),
        use_uuid: true,
        folder_slug: findStoryblokFieldValue<StringValueNode>(field, 'folder')
          ?.value,
      }
    }

    return {
      type: 'bloks',
      component_whitelist: types?.map((t) => snakeCase(t.name.value)),
      restrict_components: true,
      minimum: ifValue(
        findStoryblokFieldValue<IntValueNode>(field, 'min')?.value,
        Number
      ),
      maximum: ifValue(
        findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
        Number
      ),
    }
  }

  if (isEnumType(node) && node.astNode) {
    return {
      type: 'options',
      options: list(
        ...node.astNode.values!.map((value) =>
          map({
            name: value.description?.value ?? sentenceCase(value.name.value),
            value: value.name.value,
          })
        )
      ),
      minimum: ifValue(
        findStoryblokFieldValue<IntValueNode>(field, 'min')?.value,
        Number
      ),
      maximum: ifValue(
        findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
        Number
      ),
    }
  }

  switch (typeName(type)) {
    case 'String': {
      const datasource = findStoryblokFieldValue<StringValueNode>(
        field,
        'datasource'
      )?.value

      if (!datasource) {
        throw new Error(`Datasource is required for type ${typeName(type)}`)
      }

      return {
        type: 'options',
        datasource_slug: datasource,
        source: 'internal',
        use_uuid: true,
      }
    }
    case 'CtTypeId': {
      if (!ctConfig) {
        throw new Error(
          `Commercetools config is required for type ${typeName(type)}`
        )
      }

      const max = findStoryblokFieldValue<IntValueNode>(
        field,
        'max'
      )?.value.toString()

      const ctType = findStoryblokFieldValue<EnumValueNode>(
        field,
        'ctType'
      )?.value

      return {
        type: 'custom',
        field_type: 'sb-commercetools',
        options: list(
          ...[
            ...ctConnectionOptions(ctConfig),
            max
              ? map({
                  name: 'limit',
                  value: max,
                })
              : undefined,
            ctType
              ? map({
                  name: 'selectOnly',
                  value: ctType,
                })
              : undefined,
          ].filter(isValue)
        ),
      }
    }
  }

  throw new Error(`Unsupported array type ${typeName(type)}`)
}

const toComponentField = (
  field: FieldDefinitionNode,
  type: TypeNode,
  schema: GraphQLSchema,
  ctConfig?: CtConfig
):
  | AssetComponentField
  | BloksComponentField
  | BooleanComponentField
  | CustomComponentField
  | DatetimeComponentField
  | MarkdownComponentField
  | MultilinkComponentField
  | NumberComponentField
  | OptionComponentField
  | RichtextComponentField
  | SectionComponentField
  | TableComponentField
  | TextareaComponentField
  | TextComponentField => {
  const node = schema.getType(typeName(type))

  if (node) {
    if (isEnumType(node) && node.astNode) {
      return {
        type: 'option',
        options: list(
          ...node.astNode.values!.map((value) =>
            map({
              name: value.description?.value ?? sentenceCase(value.name.value),
              value: value.name.value,
            })
          )
        ),
      }
    }

    switch (typeName(type)) {
      case 'StoryblokAsset': {
        return {
          type: 'asset',
          filetypes:
            findStoryblokFieldValue<ConstListValueNode>(field, 'filetypes')
              ?.values.map((v) =>
                v.kind === 'EnumValue' ? (v.value as 'images') : undefined
              )
              .filter(isValue) ?? [],
        }
      }
      case 'StoryblokLink': {
        const folder = findStoryblokFieldValue<StringValueNode>(
          field,
          'folder'
        )?.value

        const linkFeatures = findStoryblokFieldValue<ConstListValueNode>(
          field,
          'linkFeatures'
        )
          ?.values.map((v) => (v.kind === 'EnumValue' ? v.value : undefined))
          .filter(isValue)

        const components = findStoryblokFieldValue<ConstListValueNode>(
          field,
          'blokTypes'
        )
          ?.values.map((v) =>
            v.kind === 'StringValue' ? snakeCase(v.value) : undefined
          )
          .filter(isValue)

        return {
          type: 'multilink',
          link_scope: folder,
          force_link_scope: Boolean(folder) || undefined,
          restrict_content_types: Boolean(components?.length) || undefined,
          component_whitelist: components,
          // allow_custom_attributes: false,
          asset_link_type: linkFeatures?.includes('assets') || undefined,
          allow_target_blank: linkFeatures?.includes('newTab') || undefined,
          email_link_type: linkFeatures?.includes('email') || undefined,
          show_anchor: linkFeatures?.includes('anchor') || undefined,
        }
      }
      case 'StoryblokSeo': {
        return {
          type: 'custom',
          field_type: 'seo-metatags',
        }
      }
      case 'StoryblokTable': {
        return {
          type: 'table',
        }
      }
    }

    if (isObjectType(node) || (isUnionType(node) && node.astNode)) {
      const types = isUnionType(node)
        ? node.astNode?.types
            ?.map((t) => schema.getType(t.name.value))
            .filter(isObjectType)
            .map((t) => t.astNode!)
        : [node.astNode!]

      // all types must have a @storyblok(type: contentType) directive
      const isContentReference = types?.every(
        (node) =>
          findStoryblokValue<EnumValueNode>(node, 'type')?.value ===
          'contentType'
      )

      if (isContentReference) {
        return {
          type: 'option',
          source: 'internal_stories',
          filter_content_type: types?.map((t) => snakeCase(t.name.value)),
          folder_slug: findStoryblokFieldValue<StringValueNode>(field, 'folder')
            ?.value,
          use_uuid: true,
        }
      }

      return {
        type: 'bloks',
        component_whitelist: types?.map((t) => snakeCase(t.name.value)),
        restrict_components: true,
        minimum: field.type.kind === 'NonNullType' ? 1 : 0,
        maximum: 1,
      }
    }
  }

  switch (typeName(type)) {
    case 'String': {
      const datasource = findStoryblokFieldValue<StringValueNode>(
        field,
        'datasource'
      )?.value

      if (datasource) {
        return {
          type: 'option',
          datasource_slug: datasource,
          source: 'internal',
          use_uuid: true,
        }
      }
      const ctType = findStoryblokFieldValue<EnumValueNode>(
        field,
        'ctType'
      )?.value

      if (ctType === 'category') {
        if (!ctConfig) {
          throw new Error(
            `Commercetools config is required for ${field.name.value}`
          )
        }
        return {
          type: 'custom',
          field_type: 'ct-category',
          options: list(...[...ctCategoryOptions(ctConfig)].filter(isValue)),
        }
      }

      const stringType = findStoryblokFieldValue<StringValueNode>(
        field,
        'format'
      )?.value

      switch (stringType) {
        case 'richtext': {
          const components = findStoryblokFieldValue<ConstListValueNode>(
            field,
            'blokTypes'
          )
            ?.values.map((v) =>
              v.kind === 'StringValue' ? snakeCase(v.value) : undefined
            )
            .filter(isValue)
            .filter(uniqueBy((x) => x))

          const toolbar = findStoryblokFieldValue<ConstListValueNode>(
            field,
            'toolbar'
          )
            ?.values.map((v) =>
              v.kind === 'EnumValue' ? paramCase(v.value) : undefined
            )
            .concat(components?.length ? ['blok'] : undefined)
            .filter(isValue)
            .filter(uniqueBy((x) => x))

          return {
            type: 'richtext',
            rtl: findStoryblokFieldValue<BooleanValueNode>(field, 'rtl')?.value,
            max_length: ifValue(
              findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
              Number
            ),
            customize_toolbar: Boolean(toolbar) || undefined,
            toolbar,
            allow_target_blank:
              findStoryblokFieldValue<ConstListValueNode>(
                field,
                'linkFeatures'
              )?.values.some(
                (v) => v.kind === 'EnumValue' && v.value === 'newTab'
              ) || undefined,
            restrict_components: Boolean(components) || undefined,
            component_whitelist: components,
          }
        }
        case 'markdown': {
          const toolbar = findStoryblokFieldValue<ConstListValueNode>(
            field,
            'toolbar'
          )
            ?.values.map((v) =>
              v.kind === 'EnumValue' ? paramCase(v.value) : undefined
            )
            .filter(isValue)

          return {
            type: 'markdown',
            rtl: findStoryblokFieldValue<BooleanValueNode>(field, 'rtl')?.value,
            max_length: ifValue(
              findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
              Number
            ),
            rich_markdown: true,
            customize_toolbar: Boolean(toolbar) || undefined,
            toolbar,
          }
        }
        case 'textarea': {
          return {
            type: 'textarea',
            rtl: findStoryblokFieldValue<BooleanValueNode>(field, 'rtl')?.value,
            max_length: ifValue(
              findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
              Number
            ),
          }
        }
        default: {
          return {
            type: 'text',
            rtl: findStoryblokFieldValue<BooleanValueNode>(field, 'rtl')?.value,
            max_length: ifValue(
              findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
              Number
            ),
            regex: findStoryblokFieldValue<IntValueNode>(field, 'regex')?.value,
          }
        }
      }
    }
    case 'Boolean': {
      return {
        type: 'boolean',
      }
    }
    case 'Int':
    case 'Float':
      return {
        type: 'number',
        decimals_value: ifValue(
          findStoryblokFieldValue<StringValueNode>(field, 'decimals')?.value,
          Number
        ),
        steps_value: ifValue(
          findStoryblokFieldValue<StringValueNode>(field, 'steps')?.value,
          Number
        ),
        min_value: ifValue(
          findStoryblokFieldValue<IntValueNode>(field, 'min')?.value,
          Number
        ),
        max_value: ifValue(
          findStoryblokFieldValue<IntValueNode>(field, 'max')?.value,
          Number
        ),
      }
    case 'Date': {
      return {
        type: 'datetime',
        disable_time: true,
      }
    }
    case 'DateTime': {
      return {
        type: 'datetime',
      }
    }
    case 'CtTypeId': {
      if (!ctConfig) {
        throw new Error(
          `Commercetools config is required for type ${typeName(type)}`
        )
      }

      const ctType = findStoryblokFieldValue<EnumValueNode>(
        field,
        'ctType'
      )?.value

      return {
        type: 'custom',
        field_type: 'sb-commercetools',
        options: list(
          ...[
            ...ctConnectionOptions(ctConfig),
            map({
              name: 'limit',
              value: '1',
            }),
            ctType
              ? map({
                  name: 'selectOnly',
                  value: findStoryblokFieldValue<EnumValueNode>(field, 'ctType')
                    ?.value,
                })
              : undefined,
          ].filter(isValue)
        ),
      }
    }
  }

  throw new Error(`Unsupported type ${typeName(type)}`)
}

const ctConnectionOptions = (ctConfig: CtConfig) => [
  map({
    name: 'endpoint',
    value: maybeArg(ctConfig.endpoint),
  }),
  map({
    name: 'clientId',
    value: maybeArg(ctConfig.clientId),
  }),
  map({
    name: 'clientSecret',
    value: maybeArg(ctConfig.clientSecret),
  }),
  map({
    name: 'locale',
    value: maybeArg(ctConfig.locale),
  }),
]

const ctCategoryOptions = (ctConfig: CtConfig) => [
  map({
    name: 'projectKey',
    value: maybeArg(ctConfig.projectKey),
  }),
  map({
    name: 'clientId',
    value: maybeArg(ctConfig.clientId),
  }),
  map({
    name: 'clientSecret',
    value: maybeArg(ctConfig.clientSecret),
  }),
]

export const maybeArg = (value: string, ...prefixes: string[]) =>
  ['var.', 'local.', ...prefixes].some((prefix) => value.startsWith(prefix))
    ? arg(value)
    : value
