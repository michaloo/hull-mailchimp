import request from "supertest";

export default class QueueAgent {
  constructor(queue) {
    this.queue = queue;
  }

  queueRequest(method, req) {
    this.queue.create("main_queue", {
      method,
      query: req.query,
      body: req.body,
    }).save((err) => {
      if (err !== null) {
        console.error(err);
      }
    });
  }

  processRequest(app) {
    this.queue.process("main_queue", (job, done) => {
      const method = job.data.method;
      request(app)
        .post(`/${method}`)
        .query(job.data.query)
        .send(job.data.body)
        .end((err) => {
          if (err) {
            return done(err);
          }
          return done();
        });
    });
  }
}
