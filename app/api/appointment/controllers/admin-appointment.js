"use strict";
const { DateTime } = require("luxon");
const { sanitizeAppointment } = require("../../../utils/sanitizers");
const {
  localizedDate,
  mergeDateAndTime,
  isWeekend,
  isHoliday,
} = require("../../../utils/date");

/**
 * Read the documentation (https://strapi.io/documentation/developer-docs/latest/development/backend-customization.html#core-controllers)
 * to customize this controller
 */

module.exports = {
  async find(ctx) {
    const userId = ctx.state.user.id;

    const date_threshold = DateTime.local()
      .minus({ days: 1 })
      .startOf("day")
      .toISO();

    const entities = await strapi
      .query("appointment")
      .find(
        { created_by: userId, start_time_gte: date_threshold, _limit: -1 },
        ["appointment_specialist", "appointment_specialist.specialist_role"]
      );

    return Promise.all(
      entities.map(
        async (appointment) => await sanitizeAppointment(appointment)
      )
    );
  },

  async create(ctx) {
    const userId = ctx.state.user.id;

    const payload = {
      ...ctx.request.body,
      created_by: userId,
      updated_by: userId,
    };

    // Add new appointment
    const entity = await strapi.query("appointment").create(payload);

    const { id } = entity;
    const { start_time, end_time, repeat_rule, repeat_until } = payload;

    // Define repeat group for repeting appointments
    const repeat_group = entity.id;
    payload.repeat_group = repeat_group;

    // List of created appointments (will be send as a response)
    const createdEntities = [
      // Update already created entity with repeat_group (=first appointment's id)
      await strapi.query("appointment").update({ id }, { repeat_group }),
    ];

    // Updates dates of the payload object
    const updatePayloadDates = (newDate) => ({
      ...payload,
      start_time: mergeDateAndTime(newDate.toISO(), start_time),
      end_time: mergeDateAndTime(newDate.toISO(), end_time),
    });

    let date = localizedDate(start_time);
    const untilDate = localizedDate(repeat_until).endOf("day");

    // Repeat appointment based on given repetition rules
    switch (repeat_rule) {
      case "daily":
        date = date.plus({ days: 1 }); // First item was already added
        while (date <= untilDate) {
          if (!isWeekend(date) && !isHoliday(date)) {
            const repeatedEntity = await strapi
              .query("appointment")
              .create(updatePayloadDates(date));
            createdEntities.push(repeatedEntity);
          }
          date = date.plus({ days: 1 });
        }
        break;
      case "weekly":
        date = date.plus({ weeks: 1 }); // First item was already added
        while (date <= untilDate) {
          if (!isHoliday(date)) {
            const repeatedEntity = await strapi
              .query("appointment")
              .create(updatePayloadDates(date));
            createdEntities.push(repeatedEntity);
          }
          date = date.plus({ weeks: 1 });
        }
        break;
      default:
      // do nothing
    }

    return Promise.all(
      createdEntities.map(async (entity) => await sanitizeAppointment(entity))
    );
  },

  async edit(ctx) {
    const { id } = ctx.params;
    const userId = ctx.state.user.id;
    const { repeatScope } = ctx.query;

    const payload = {
      ...ctx.request.body,
      updated_by: userId,
      updated_at: DateTime.local().toISO(),
    };

    const baseQuery = { created_by: userId, _limit: -1 };

    let editedEntities = [];

    const getUpdatedTimes = (entity) => ({
      start_time: mergeDateAndTime(entity.start_time, payload.start_time),
      end_time: mergeDateAndTime(entity.end_time, payload.end_time),
    });

    switch (repeatScope) {
      case "all":
        const allInRepeatGroup = await strapi
          .query("appointment")
          .find({ ...baseQuery, repeat_group: payload.repeat_group });

        editedEntities = await Promise.all(
          allInRepeatGroup.map(async (entity) => {
            return await strapi
              .query("appointment")
              .update(
                { id: entity.id },
                { ...payload, ...getUpdatedTimes(entity) }
              );
          })
        );
        break;
      case "following":
        const allFollowingEntities = await strapi.query("appointment").find({
          ...baseQuery,
          repeat_group: payload.repeat_group,
          start_time_gte: payload.start_time,
        });

        editedEntities = await Promise.all(
          allFollowingEntities.map(async (entity) => {
            return await strapi
              .query("appointment")
              .update(
                { id: entity.id },
                { ...payload, ...getUpdatedTimes(entity) }
              );
          })
        );
        break;
      default:
        editedEntities.push(
          await strapi
            .query("appointment")
            .update({ ...baseQuery, id }, payload)
        );
    }

    return Promise.all(
      editedEntities.map(async (entity) => await sanitizeAppointment(entity))
    );
  },

  async cancel(ctx) {
    const { id } = ctx.params;
    const userId = ctx.state.user.id;

    const entity = await strapi
      .query("appointment")
      .update({ id, created_by: userId }, { status: "cancelled" });

    if (entity.id === Number(id)) {
      ctx.send({ ok: true });
    } else {
      ctx.send({ ok: false });
    }
  },

  async delete(ctx) {
    const { id } = ctx.params;
    const userId = ctx.state.user.id;
    const { repeatScope } = ctx.query;

    let deletedIds = [];

    const entity = await strapi
      .query("appointment")
      .findOne({ id, created_by: userId });

    const { start_time, repeat_group } = entity;

    const updateRepeatUntilValues = async () => {
      const allInRepeatGroup = await strapi
        .query("appointment")
        .find({ created_by: userId, repeat_group, _limit: -1 });

      const sorted = allInRepeatGroup.sort((a, b) =>
        b.start_time.localeCompare(a.start_time)
      );
      const latestAppointment = sorted?.[0];

      await Promise.all(
        allInRepeatGroup.map(async (entity) => {
          return await strapi.query("appointment").update(
            { id: entity.id },
            {
              repeat_until: localizedDate(latestAppointment.start_time)
                .endOf("day")
                .toISO(),
            }
          );
        })
      );
    };

    switch (repeatScope) {
      case "all":
        if (repeat_group) {
          // Delete all appointments in a given group
          const entities = await strapi
            .query("appointment")
            .delete({ repeat_group, created_by: userId });
          deletedIds = [deletedIds, ...entities.map(({ id }) => id)];
        }
        break;
      case "following":
        if (repeat_group) {
          // Delete all FOLLOWING appointments in a given group
          const entities = await strapi.query("appointment").delete({
            start_time_gte: start_time,
            repeat_group,
            created_by: userId,
          });
          await updateRepeatUntilValues();
          deletedIds = [deletedIds, ...entities.map(({ id }) => id)];
        }
        break;
      default:
        // Delete just one appointment
        const entity = await strapi
          .query("appointment")
          .delete({ id, created_by: userId });
        await updateRepeatUntilValues();
        if (entity?.id) deletedIds.push(entity.id);
    }
    return { deletedIds };
  },
};
