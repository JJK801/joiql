//
// Takes an object of { key: JoiSchema } pairs to generate a GraphQL Schema.
//
const Joi = require('joi')
const {
  uniqueId,
  map,
  find,
  capitalize,
  keys,
  isEqual,
  assign,
  flatten,
  isEmpty,
  mapValues,
  omitBy,
  isNull
} = require('lodash')
const {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLUnionType,
  GraphQLBoolean,
  GraphQLNonNull
} = require('graphql')

// Convenience helpers to determine a Joi schema's
// "presence", e.g. required or forbidden
const presence = (desc, name) =>
  desc.flags &&
  desc.flags.presence &&
  desc.flags.presence === name

// Cache converted types by their `meta({ name: '' })` property so we
// don't end up with a litter of anonymously generated GraphQL types
const cachedTypes = {}

// Maps a Joi description to a GraphQL type. `isInput` is used to determine
// when to use, say, GraphQLInputObjectType vs. GraphQLObjectType—useful in
// cases such as args and mutations.
const descToType = (desc, isInput) => {
  let typeName = (
    (isInput ? 'Input' : '') +
    (map(desc.meta, 'name')[0] || 'Anon' + uniqueId())
  )
  const required = isInput && presence(desc, 'required')
  const type = {
    boolean: () => GraphQLBoolean,
    date: () => GraphQLString,
    string: () => GraphQLString,
    number: () => {
      const isInteger = !!find(desc.rules, { name: 'integer' })
      return isInteger ? GraphQLInt : GraphQLFloat
    },
    object: () => {
      if (cachedTypes[typeName]) return cachedTypes[typeName]
      let type
      if (isInput) {
        type = new GraphQLInputObjectType({
          name: typeName,
          description: desc.description,
          fields: omitBy(mapValues(desc.children, (child) => {
            if (presence(child, 'forbidden')) return null
            return { type: descToType(child, true) }
          }), isNull)
        })
      } else {
        type = new GraphQLObjectType({
          name: typeName,
          description: desc.description,
          fields: descsToFields(desc.children)
        })
      }
      cachedTypes[typeName] = type
      return type
    },
    array: () => {
      let type
      const items = desc.items.filter((item) => !presence(item, 'forbidden'))
      if (items.length === 1) {
        type = descToType(items[0], isInput)
      } else {
        typeName = map(items, (d) => {
          const name = (
            (d.meta && capitalize(d.meta.name)) ||
            capitalize(d.type) ||
            'Anon' + uniqueId()
          )
          return (isInput ? 'Input' : '') + name
        }).join('Or')
        type = makeArrayAlternativeType(cachedTypes, isInput, typeName, desc, items)
      }
      if (!cachedTypes[typeName]) cachedTypes[typeName] = type
      return new GraphQLList(type)
    },
    alternatives: () => {
      let type
      const alternatives = desc.alternatives
        .filter((a) => !presence(a, 'forbidden'))
      type = makeArrayAlternativeType(cachedTypes, isInput, typeName, desc, alternatives)
      if (!cachedTypes[typeName]) cachedTypes[typeName] = type
      return type
    }
  }[desc.type]()
  return required ? new GraphQLNonNull(type) : type
}

const makeArrayAlternativeType = (cachedTypes, isInput, typeName, desc, items) => {
  const types = items.map((item) => descToType(item, isInput))

  if (cachedTypes[typeName]) {
    return cachedTypes[typeName]
  } else if (isInput) {
    const children = items.map((item) => item.children)
    const fields = descsToFields(assign(...flatten(children)))
    return new GraphQLInputObjectType({
      name: typeName,
      description: desc.description,
      fields: fields
    })
  } else {
    return new GraphQLUnionType({
      name: typeName,
      description: desc.description,
      types: types,
      resolveType: (val) =>
        find(map(items, (item, i) => {
          const isTypeOf = map(item.meta, 'isTypeOf')[0]
          if (isTypeOf) return isTypeOf(val) && types[i]
          // TODO: Should use JOI.validate(), just looks at matching keys
          // We might need to pass schema here instead
          else return isEqual(keys(val), keys(item.children)) && types[i]
        }))
    })
  }
}

// Convert a Joi description's `meta({ args: {} })` to a GraphQL field's
// arguments
const descToArgs = (desc) => {
  const argsSchema = map(desc.meta, 'args')[0]
  return argsSchema && omitBy(mapValues(argsSchema, (schema) => {
    if (presence(schema.describe(), 'forbidden')) return null
    return {
      type: descToType(schema.describe(), true)
    }
  }), isNull)
}

// Wraps a resolve function specifid in a Joi schema to add validation.
const validatedResolve = (desc) => (source, args, root, opts) => {
  const resolve = desc.meta && desc.meta[0].resolve
  if (args && !isEmpty(args)) {
    const argsSchema = map(desc.meta, 'args')[0]
    const { value, error } = Joi.validate(args, argsSchema)
    if (error) throw error
    return resolve(source, value, root, opts)
  }
  if (resolve) return resolve(source, args, root, opts)
  else return source && source[opts.fieldASTs[0].name.value]
}

// Convert a hash of descriptions into an object appropriate to put in a
// GraphQL.js `fields` key.
const descsToFields = (descs, resolveMiddlewares = () => {}) =>
  omitBy(mapValues(descs, (desc) => {
    if (presence(desc, 'forbidden')) return null
    return {
      type: descToType(desc),
      args: descToArgs(desc),
      description: desc.description || '',
      resolve: validatedResolve(desc)
    }
  }), isNull)

// Converts the { key: JoiSchema } pairs to a GraphQL.js schema object
module.exports = (jois) => {
  const attrs = {}
  if (jois.query) {
    attrs.query = new GraphQLObjectType({
      name: 'RootQueryType',
      fields: descsToFields(mapValues(jois.query, (j) => j.describe()))
    })
  }
  if (jois.mutation) {
    attrs.mutation = new GraphQLObjectType({
      name: 'RootMutationType',
      fields: descsToFields(mapValues(jois.mutation, (j) => j.describe()))
    })
  }
  return new GraphQLSchema(attrs)
}
