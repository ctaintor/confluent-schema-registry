import path from 'path'
import { v4 as uuid } from 'uuid'

import { readAVSC } from './utils'
import SchemaRegistry from './SchemaRegistry'
import API from './api'
import { compatibility } from './constants'

const encodedAnotherPersonV2 = require('../fixtures/encodedAnotherPersonV2.json') // eslint-disable-line @typescript-eslint/no-var-requires
const wrongMagicByte = require('../fixtures/wrongMagicByte.json') // eslint-disable-line @typescript-eslint/no-var-requires

const TEST_REGISTRY = 'http://localhost:8982'
const PersonSchema = readAVSC(path.join(__dirname, '../fixtures/avsc/person.avsc'))
const payload = { full_name: 'John Doe' } // eslint-disable-line @typescript-eslint/camelcase

describe('SchemaRegistry', () => {
  let registry: any

  beforeEach(async () => {
    registry = new SchemaRegistry({ host: TEST_REGISTRY })
    await registry.register(PersonSchema)
  })

  describe('#register', () => {
    let namespace, Schema: any, subject: any, api: any

    beforeEach(() => {
      api = API({ host: TEST_REGISTRY })
      namespace = `N${uuid().replace(/-/g, '_')}`
      subject = `${namespace}.RandomTest`
      Schema = JSON.parse(`
        {
          "type": "record",
          "name": "RandomTest",
          "namespace": "${namespace}",
          "fields": [{ "type": "string", "name": "full_name" }]
        }
      `)
    })

    it('uploads the new schema', async () => {
      await expect(api.Subject.latestVersion({ subject })).rejects.toHaveProperty(
        'message',
        'SchemaRegistry - Subject not found.',
      )

      await expect(registry.register(Schema)).resolves.toEqual({ id: expect.any(Number) })
    })

    it('automatically cache the id and schema', async () => {
      const { id } = await registry.register(Schema)
      expect(registry.cache.getSchema(id)).toBeTruthy()
    })

    it('set the default compatibility to BACKWARD', async () => {
      await registry.register(Schema)
      const response = await api.Subject.config({ subject })
      expect(response.data()).toEqual({ compatibilityLevel: compatibility.BACKWARD })
    })

    it('sets the compatibility according to param', async () => {
      await registry.register(Schema, { compatibility: compatibility.NONE })
      const response = await api.Subject.config({ subject })
      expect(response.data()).toEqual({ compatibilityLevel: compatibility.NONE })
    })

    it('throws an error when schema does not have a name', async () => {
      delete Schema.name
      await expect(registry.register(Schema)).rejects.toHaveProperty(
        'message',
        'Invalid name: undefined',
      )
    })

    it('throws an error when schema does not have a namespace', async () => {
      delete Schema.namespace
      await expect(registry.register(Schema)).rejects.toHaveProperty(
        'message',
        'Invalid namespace: undefined',
      )
    })

    it('throws an error when the configured compatibility is different than defined in the client', async () => {
      await registry.register(Schema)
      await api.Subject.updateConfig({ subject, body: { compatibility: compatibility.FULL } })
      await expect(registry.register(Schema)).rejects.toHaveProperty(
        'message',
        'Compatibility does not match the configuration (BACKWARD != FULL)',
      )
    })
  })

  describe('#encode', () => {
    beforeEach(async () => {
      await registry.register(PersonSchema)
    })

    it('throws an error if registryId is empty', async () => {
      await expect(registry.encode(undefined, payload)).rejects.toHaveProperty(
        'message',
        'Invalid registryId: undefined',
      )
    })

    it('encodes using a defined registryId', async () => {
      const SchemaV1 = Object.assign({}, PersonSchema, {
        name: 'AnotherPerson',
        fields: [{ type: 'string', name: 'full_name' }],
      })
      const SchemaV2 = Object.assign({}, SchemaV1, {
        fields: [
          { type: 'string', name: 'full_name' },
          { type: 'string', name: 'city', default: 'Stockholm' },
        ],
      })

      const schema1 = await registry.register(SchemaV1)
      const schema2 = await registry.register(SchemaV2)
      expect(schema2.id).not.toEqual(schema1.id)

      const data = await registry.encode(schema2.id, payload)
      // eslint-disable-next-line @typescript-eslint/ban-ts-ignore
      // @ts-ignore
      expect(data).toMatchConfluentAvroEncodedPayload({
        registryId: schema2.id,
        payload: Buffer.from(encodedAnotherPersonV2),
      })
    })
  })

  describe('#decode', () => {
    let registryId: any

    beforeEach(async () => {
      registryId = (await registry.register(PersonSchema)).id
    })

    it('decodes data', async () => {
      const buffer = Buffer.from(await registry.encode(registryId, payload))
      const data = await registry.decode(buffer)
      expect(data).toEqual(payload)
    })

    it('throws an error if the magic byte is not supported', async () => {
      const buffer = Buffer.from(wrongMagicByte)
      await expect(registry.decode(buffer)).rejects.toHaveProperty(
        'message',
        'Message encoded with magic byte {"type":"Buffer","data":[48]}, expected {"type":"Buffer","data":[0]}',
      )
    })

    it('caches the schema', async () => {
      const buffer = Buffer.from(await registry.encode(registryId, payload))

      registry.cache.clear()
      await registry.decode(buffer)

      expect(registry.cache.getSchema(registryId)).toBeTruthy()
    })

    describe('when the cache is populated', () => {
      it('uses the cache data', async () => {
        const buffer = Buffer.from(await registry.encode(registryId, payload))
        expect(registry.cache.getSchema(registryId)).toBeTruthy()

        jest.spyOn(registry.cache, 'setSchema')
        await registry.decode(buffer)

        expect(registry.cache.setSchema).not.toHaveBeenCalled()
      })
    })
  })
})
