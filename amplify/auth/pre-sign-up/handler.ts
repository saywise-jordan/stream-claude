import type { PreSignUpTriggerHandler } from "aws-lambda";

export const handler: PreSignUpTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email;

  if (email) {
    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (emailDomain !== 'saywise.com') {
      throw new Error('InvalidEmailDomainException');
    }
  }

  return event;
};
