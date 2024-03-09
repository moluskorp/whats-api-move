import { FastifyInstance } from 'fastify'

export async function localizacaoRoutes(app: FastifyInstance) {
  app.get('/', { websocket: true }, async (connection, req) => {
    connection.socket.on('message', (message) => {
      console.log(message)
    })

    connection.on('data', (data) => {
      console.log({ data })
    })

    connection.socket.on('open', () => {
      console.log('conectou')
    })
  })
}
