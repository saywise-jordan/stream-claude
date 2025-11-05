export const handler = awslambda.streamifyResponse(
  async (event, responseStream) => {
    // Metadata is a JSON serializable JS object. Its shape is not defined here.
    const metadata = {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        CustomHeader: "outerspace",
      },
    };

    // Assign to the responseStream parameter to prevent accidental reuse of the non-wrapped stream.
    responseStream = awslambda.HttpResponseStream.from(
      responseStream,
      metadata
    );

    responseStream.write("Streaming with Helper \n");
    await new Promise((r) => setTimeout(r, 1000));
    responseStream.write("Hello 0 \n");
    await new Promise((r) => setTimeout(r, 1000));
    responseStream.write("Hello 1 \n");
    await new Promise((r) => setTimeout(r, 1000));
    responseStream.write("Hello 2 \n");
    await new Promise((r) => setTimeout(r, 1000));
    responseStream.end();
  }
);
